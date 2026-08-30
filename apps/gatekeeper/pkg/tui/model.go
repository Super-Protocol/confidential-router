package tui

import (
	"context"
	"fmt"
	"time"

	"github.com/charmbracelet/bubbles/help"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// maxLogLines is how much of the log tail is kept. A dashboard is not a log
// store: the tail exists to explain the state on screen right now.
const maxLogLines = 500

// flashFor is how long an action's result stays in the status bar.
const flashFor = 6 * time.Second

// pane is which half of the lower screen is shown. Both never fit on a small
// terminal, and forcing them to would make each unreadable.
type pane int

const (
	paneDetail pane = iota
	paneLogs
)

// Model is the dashboard.
type Model struct {
	opts   Options
	keys   keyMap
	styles styles
	help   help.Model

	table    table.Model
	snapshot status.Snapshot
	logs     []status.LogLine

	events <-chan status.Event
	cancel context.CancelFunc

	width, height int
	pane          pane
	showHelp      bool

	// flash is the result of the last action, shown briefly in the status bar.
	flash      string
	flashError bool
	flashUntil time.Time

	quitting bool
}

// New builds the dashboard model.
func New(opts Options) Model {
	columns := []table.Column{
		{Title: "ENDPOINT", Width: 18},
		{Title: "LISTEN", Width: 18},
		{Title: "UPSTREAM", Width: 28},
		{Title: "STATUS", Width: 17},
		{Title: "LAST ATTEST", Width: 12},
		{Title: "REQ/S", Width: 7},
		{Title: "IN/OUT", Width: 16},
	}
	t := table.New(
		table.WithColumns(columns),
		table.WithFocused(true),
		table.WithHeight(6),
	)
	t.SetStyles(tableStyles())

	h := help.New()
	h.ShowAll = false

	return Model{
		opts:   opts,
		keys:   defaultKeys(),
		styles: newStyles(),
		help:   h,
		table:  t,
		pane:   paneDetail,
		// A sane size before the first WindowSizeMsg, so a View() taken by a
		// test or a non-resizing terminal is still laid out.
		width:  100,
		height: 30,
	}
}

// Init implements tea.Model: take a first snapshot and start listening.
func (m Model) Init() tea.Cmd {
	return tea.Batch(m.subscribe(), m.refresh())
}

// snapshotMsg carries a new full state of every endpoint.
type snapshotMsg status.Snapshot

// logMsg carries one line for the tail.
type logMsg status.LogLine

// eventsEndedMsg says the supervisor stopped publishing.
type eventsEndedMsg struct{}

// flashMsg is the outcome of a key that did something.
type flashMsg struct {
	text  string
	isErr bool
}

// tickMsg drives the relative timestamps ("12s ago") without an event.
type tickMsg time.Time

// subscribe opens the event stream once and hands the channel back through a
// message, so that Update owns it from then on.
func (m Model) subscribe() tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithCancel(context.Background())
		return subscribedMsg{events: m.opts.Supervisor.Events(ctx), cancel: cancel}
	}
}

type subscribedMsg struct {
	events <-chan status.Event
	cancel context.CancelFunc
}

// refresh asks for a snapshot now rather than waiting for the next event, so
// the dashboard is populated the moment it opens.
func (m Model) refresh() tea.Cmd {
	return func() tea.Msg {
		return snapshotMsg(m.opts.Supervisor.Snapshot(context.Background()))
	}
}

// waitForEvent blocks on the stream for one event and re-arms itself.
func waitForEvent(events <-chan status.Event) tea.Cmd {
	return func() tea.Msg {
		event, ok := <-events
		if !ok {
			return eventsEndedMsg{}
		}
		switch {
		case event.Kind == status.EventSnapshot && event.Snapshot != nil:
			return snapshotMsg(*event.Snapshot)
		case event.Kind == status.EventLog && event.Log != nil:
			return logMsg(*event.Log)
		default:
			return nil
		}
	}
}

func tick() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// Update implements tea.Model.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.layout()
		return m, nil

	case subscribedMsg:
		m.events, m.cancel = msg.events, msg.cancel
		return m, tea.Batch(waitForEvent(m.events), tick())

	case snapshotMsg:
		m.adopt(status.Snapshot(msg))
		return m, waitForEvent(m.events)

	case logMsg:
		m.logs = append(m.logs, status.LogLine(msg))
		if len(m.logs) > maxLogLines {
			m.logs = m.logs[len(m.logs)-maxLogLines:]
		}
		return m, waitForEvent(m.events)

	case eventsEndedMsg:
		m.events = nil
		return m, nil

	case flashMsg:
		m.flash, m.flashError = msg.text, msg.isErr
		m.flashUntil = m.opts.now().Add(flashFor)
		return m, m.refresh()

	case tickMsg:
		if !m.flashUntil.IsZero() && m.opts.now().After(m.flashUntil) {
			m.flash, m.flashError, m.flashUntil = "", false, time.Time{}
		}
		return m, tick()

	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.Quit):
		m.quitting = true
		m.stop()
		return m, tea.Quit

	case key.Matches(msg, m.keys.Help):
		m.showHelp = !m.showHelp
		m.help.ShowAll = m.showHelp
		m.layout()
		return m, nil

	case key.Matches(msg, m.keys.Logs):
		if m.pane == paneDetail {
			m.pane = paneLogs
		} else {
			m.pane = paneDetail
		}
		return m, nil

	case key.Matches(msg, m.keys.Toggle):
		return m, m.toggleSelected()

	case key.Matches(msg, m.keys.Reattest):
		return m, m.reattestSelected()

	case key.Matches(msg, m.keys.Pin):
		return m, m.pinSelected()

	case key.Matches(msg, m.keys.AddRoot):
		return m, m.addRootSelected()
	}

	var cmd tea.Cmd
	m.table, cmd = m.table.Update(msg)
	return m, cmd
}

// stop releases the event subscription. It is safe to call more than once.
func (m Model) stop() {
	if m.cancel != nil {
		m.cancel()
	}
}

// selected is the endpoint the cursor is on.
func (m Model) selected() (status.Endpoint, bool) {
	cursor := m.table.Cursor()
	if cursor < 0 || cursor >= len(m.snapshot.Endpoints) {
		return status.Endpoint{}, false
	}
	return m.snapshot.Endpoints[cursor], true
}

// toggleSelected starts a stopped endpoint and stops a running one.
func (m Model) toggleSelected() tea.Cmd {
	ep, ok := m.selected()
	if !ok {
		return nil
	}
	supervisor := m.opts.Supervisor
	return func() tea.Msg {
		ctx := context.Background()
		if ep.Health == status.Stopped {
			if err := supervisor.Start(ctx, ep.Name); err != nil {
				return flashMsg{text: fmt.Sprintf("starting %s: %v", ep.Name, err), isErr: true}
			}
			return flashMsg{text: fmt.Sprintf("started %s", ep.Name)}
		}
		if err := supervisor.Stop(ctx, ep.Name); err != nil {
			return flashMsg{text: fmt.Sprintf("stopping %s: %v", ep.Name, err), isErr: true}
		}
		return flashMsg{text: fmt.Sprintf("stopped %s", ep.Name)}
	}
}

// reattestSelected forces a fresh verification, bypassing the verdict cache.
func (m Model) reattestSelected() tea.Cmd {
	ep, ok := m.selected()
	if !ok {
		return nil
	}
	supervisor := m.opts.Supervisor
	return func() tea.Msg {
		report, err := supervisor.Reattest(context.Background(), ep.Name)
		if err != nil {
			return flashMsg{text: fmt.Sprintf("re-attesting %s: %v", ep.Name, err), isErr: true}
		}
		if report != nil && !report.Admitted {
			return flashMsg{text: fmt.Sprintf("%s: %s", ep.Name, report.Denied()), isErr: true}
		}
		return flashMsg{text: fmt.Sprintf("%s re-attested", ep.Name)}
	}
}

// pinSelected is "Trust this deployment": pin whatever the endpoint publishes
// right now.
//
// It refuses on an endpoint that did not pass verification. The digest of an
// unverifiable bundle is not evidence of anything, and a dashboard key is
// exactly where that distinction would otherwise be lost.
func (m Model) pinSelected() tea.Cmd {
	ep, ok := m.selected()
	if !ok {
		return nil
	}
	store := m.opts.Store
	return func() tea.Msg {
		switch {
		case store == nil:
			return flashMsg{text: "the configuration is not writable from here", isErr: true}
		case ep.PublishedDigest == "":
			return flashMsg{text: fmt.Sprintf("%s publishes no evidenceDigest yet", ep.Name), isErr: true}
		case ep.Report == nil || !ep.Report.Verified:
			return flashMsg{
				text:  fmt.Sprintf("%s has not passed verification; its digest means nothing", ep.Name),
				isErr: true,
			}
		}
		digest, err := trust.ParseDigest(ep.PublishedDigest)
		if err != nil {
			return flashMsg{text: fmt.Sprintf("%s: %v", ep.Name, err), isErr: true}
		}
		added, err := store.AddPin(ep.Name, digest)
		if err != nil {
			return flashMsg{text: fmt.Sprintf("pinning %s: %v", ep.Name, err), isErr: true}
		}
		if !added {
			return flashMsg{text: fmt.Sprintf("%s was already pinned for %s", digest, ep.Name)}
		}
		return flashMsg{text: fmt.Sprintf("pinned %s for %s — press r to re-attest", digest, ep.Name)}
	}
}

// addRootSelected is the desktop gatekeeper's "Add to trusted clouds": take the
// root a failed chain terminated in and trust it.
func (m Model) addRootSelected() tea.Cmd {
	ep, ok := m.selected()
	if !ok {
		return nil
	}
	store := m.opts.Store
	return func() tea.Msg {
		switch {
		case store == nil:
			return flashMsg{text: "the configuration is not writable from here", isErr: true}
		case ep.Report == nil || ep.Report.UntrustedRootPEM == "":
			return flashMsg{
				text:  fmt.Sprintf("%s did not present an untrusted root to add", ep.Name),
				isErr: true,
			}
		}
		// The endpoint's own name is the only meaningful label available here;
		// a user who wants a better one renames it in the config.
		added, err := store.AddRoot(ep.Name+"-root", []byte(ep.Report.UntrustedRootPEM))
		if err != nil {
			return flashMsg{text: fmt.Sprintf("adding root: %v", err), isErr: true}
		}
		if !added {
			return flashMsg{text: "that root is already trusted"}
		}
		return flashMsg{text: fmt.Sprintf("trusted the root %s presented — press r to re-attest", ep.Name)}
	}
}

// adopt replaces the snapshot and rebuilds the table, keeping the cursor on the
// same endpoint rather than on the same row number: endpoints come and go on
// reload, and a cursor that silently moves to another endpoint is how someone
// stops the wrong listener.
func (m *Model) adopt(snapshot status.Snapshot) {
	var focused string
	if selected, ok := m.selected(); ok {
		focused = selected.Name
	}
	m.snapshot = snapshot
	m.syncRows(focused)
}

// syncRows rebuilds the table rows, restoring the cursor to the named endpoint
// when it is still there.
func (m *Model) syncRows(focused string) {
	visible := columnsFor(m.contentWidth())
	// The rows are cleared first: bubbles/table re-renders on SetColumns, and
	// rows built for a wider layout would have more cells than there are
	// columns to put them in.
	m.table.SetRows(nil)
	m.table.SetColumns(visible)
	// The table draws its own header rule at its own width; without this it
	// would be the default 0 and the rule would wrap out of the pane.
	m.table.SetWidth(m.contentWidth())

	rows := make([]table.Row, 0, len(m.snapshot.Endpoints))
	cursor := 0
	now := m.opts.now()
	for i, ep := range m.snapshot.Endpoints {
		if ep.Name == focused {
			cursor = i
		}
		rows = append(rows, rowFor(m.styles, visible, ep, now))
	}
	m.table.SetRows(rows)
	if cursor < len(rows) {
		m.table.SetCursor(cursor)
	}
}
