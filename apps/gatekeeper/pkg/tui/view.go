package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/lipgloss"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// Layout constants. The dashboard has to stay readable in the 80×24 pane a
// laptop terminal actually is, so everything below the endpoints table is
// optional and the table is what survives.
const (
	minWidth     = 48
	minTableRows = 2
	// minPaneHeight is the smallest a detail or log pane may be before it is
	// dropped instead of drawn as a two-line stub.
	minPaneHeight = 6
	// cellPadding is what bubbles/table adds around every cell; the column
	// widths have to be chosen inside the space that leaves.
	cellPadding = 2
	// tableHeaderLines is the header and its rule. bubbles/table's SetHeight
	// counts them, so a height of N shows N-2 endpoints.
	tableHeaderLines = 2
)

// column identifies one table column, so the responsive layout can drop whole
// columns and still build matching rows.
type column int

const (
	colName column = iota
	colListen
	colUpstream
	colStatus
	colAttest
	colRate
	colTraffic
)

// columnPlan is one breakpoint: the columns it shows and their fixed widths.
// Narrower terminals lose the columns a glance needs least — traffic counters
// first, then the rate, then the upstream — and never the status.
type columnPlan struct {
	minWidth int
	columns  []column
}

var columnPlans = []columnPlan{
	{110, []column{colName, colListen, colUpstream, colStatus, colAttest, colRate, colTraffic}},
	{92, []column{colName, colListen, colUpstream, colStatus, colAttest, colRate}},
	{74, []column{colName, colListen, colUpstream, colStatus, colAttest}},
	{56, []column{colName, colListen, colStatus, colAttest}},
	{0, []column{colName, colStatus}},
}

// fixedWidths are the columns whose content has a known shape; the identifying
// columns share whatever is left.
var fixedWidths = map[column]int{
	colStatus:  16,
	colAttest:  12,
	colRate:    6,
	colTraffic: 15,
}

var columnTitles = map[column]string{
	colName:     "ENDPOINT",
	colListen:   "LISTEN",
	colUpstream: "UPSTREAM",
	colStatus:   "STATUS",
	colAttest:   "LAST ATTEST",
	colRate:     "REQ/S",
	colTraffic:  "IN/OUT",
}

// columnsFor picks the widest plan that fits and distributes the leftover width
// between the name, listen and upstream columns.
func columnsFor(width int) []table.Column {
	plan := columnPlans[len(columnPlans)-1]
	for _, candidate := range columnPlans {
		if width >= candidate.minWidth {
			plan = candidate
			break
		}
	}

	flexible := width - cellPadding*len(plan.columns)
	var flexibleColumns []column
	for _, id := range plan.columns {
		if fixed, ok := fixedWidths[id]; ok {
			flexible -= fixed
		} else {
			flexibleColumns = append(flexibleColumns, id)
		}
	}
	share := maxInt(8, flexible/maxInt(1, len(flexibleColumns)))

	out := make([]table.Column, 0, len(plan.columns))
	for i, id := range plan.columns {
		w, fixed := fixedWidths[id]
		if !fixed {
			w = share
			// The last flexible column absorbs the rounding, so the table fills
			// the width it was given exactly.
			if isLastFlexible(plan.columns, flexibleColumns, i) {
				w = maxInt(8, flexible-share*(len(flexibleColumns)-1))
			}
		}
		out = append(out, table.Column{Title: columnTitles[id], Width: w})
	}
	return out
}

func isLastFlexible(columns []column, flexible []column, index int) bool {
	if len(flexible) == 0 {
		return false
	}
	last := flexible[len(flexible)-1]
	return columns[index] == last
}

// rowFor renders one endpoint into the currently visible columns.
func rowFor(s styles, visible []table.Column, ep status.Endpoint, now time.Time) table.Row {
	byTitle := map[string]string{
		columnTitles[colName]:     ep.Name,
		columnTitles[colListen]:   ep.Listen,
		columnTitles[colUpstream]: ep.Upstream,
		columnTitles[colStatus]:   s.health(ep.Health).Render(ep.Health.Label()),
		columnTitles[colAttest]:   relative(now, ep.LastAttestAt),
		columnTitles[colRate]:     fmt.Sprintf("%.1f", ep.RequestsPerSecond),
		columnTitles[colTraffic]:  humanBytes(ep.BytesIn) + "/" + humanBytes(ep.BytesOut),
	}
	row := make(table.Row, 0, len(visible))
	for _, col := range visible {
		row = append(row, byTitle[col.Title])
	}
	return row
}

// layout recomputes what depends on the terminal's width. Heights are decided
// in View, where the rendered panes can be measured rather than predicted.
func (m *Model) layout() {
	m.help.Width = m.width
	m.syncRows(m.focusedName())
}

func (m Model) focusedName() string {
	if selected, ok := m.selected(); ok {
		return selected.Name
	}
	return ""
}

func tableStyles() table.Styles {
	s := table.DefaultStyles()
	s.Header = s.Header.
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(colourBorder).
		BorderBottom(true).
		Bold(true).
		Foreground(colourMuted)
	s.Selected = s.Selected.
		Foreground(colourText).
		Background(colourSelected).
		Bold(true)
	s.Cell = s.Cell.Foreground(colourText)
	return s
}

// View implements tea.Model.
//
// Heights are budgeted here, against panes that have actually been rendered:
// the header, status bar and help are measured, the table is given as many rows
// as fit, and the detail or log pane takes what is left — or is dropped. The
// receiver is a copy, so the table resizing this does is part of producing the
// frame and does not leak into the model.
func (m Model) View() string {
	if m.quitting {
		return ""
	}

	header := m.header()
	statusBar := m.statusBar()
	help := m.help.View(m.keys)
	available := m.height - lipgloss.Height(header) - lipgloss.Height(statusBar) - lipgloss.Height(help)

	tablePane, used := m.renderTable(available)
	sections := []string{header, tablePane}

	if rest := available - used; rest >= minPaneHeight {
		body := m.detailView(rest - 2)
		if m.pane == paneLogs {
			body = m.logView(rest - 2)
		}
		sections = append(sections, m.styles.pane.Width(m.paneWidth()).Height(rest-2).Render(body))
	}
	sections = append(sections, statusBar, help)
	return lipgloss.JoinVertical(lipgloss.Left, sections...)
}

// renderTable fits the endpoints table into at most `available` lines, shrinking
// it row by row until it does, and reports how many lines it took.
func (m Model) renderTable(available int) (string, int) {
	rows := maxInt(minTableRows, len(m.snapshot.Endpoints))
	for {
		m.table.SetHeight(rows + tableHeaderLines)
		pane := m.styles.pane.Width(m.paneWidth()).Render(m.table.View())
		height := lipgloss.Height(pane)
		if height <= available || rows <= 1 {
			return pane, height
		}
		rows--
	}
}

// paneWidth is what a bordered pane's style is given. lipgloss counts padding
// inside Width and the border outside it, so this is the terminal width minus
// the two border columns.
func (m Model) paneWidth() int { return maxInt(minWidth, m.width) - 2 }

// contentWidth is the space left inside a pane once its padding is taken —
// what the table and every truncated line have to fit into.
func (m Model) contentWidth() int { return m.paneWidth() - 2 }

func (m Model) header() string {
	counts := map[status.Health]int{}
	for _, ep := range m.snapshot.Endpoints {
		counts[ep.Health]++
	}
	summary := fmt.Sprintf("%d confidential", counts[status.Confidential])
	if n := counts[status.NonConfidential]; n > 0 {
		summary += m.styles.warn.Render(fmt.Sprintf(" · %d non-confidential", n))
	}
	if n := counts[status.Broken]; n > 0 {
		summary += m.styles.bad.Render(fmt.Sprintf(" · %d broken", n))
	}
	if n := counts[status.Attesting]; n > 0 {
		summary += fmt.Sprintf(" · %d attesting", n)
	}
	if n := counts[status.Stopped]; n > 0 {
		summary += m.styles.muted.Render(fmt.Sprintf(" · %d stopped", n))
	}

	title := m.styles.title.Render("gatekeeper") + "  " + summary
	subtitle := m.styles.subtitle.Render(truncate(m.opts.ConfigPath, m.width))
	return lipgloss.JoinVertical(lipgloss.Left, title, subtitle)
}

// detailView renders the selected endpoint's verification: the chain, the
// fingerprints, the digest, the images and every policy's result.
func (m Model) detailView(height int) string {
	ep, ok := m.selected()
	if !ok {
		return m.styles.muted.Render("No endpoint selected.")
	}

	lines := []string{m.styles.paneTitle.Render(ep.Name) + "  " +
		m.styles.health(ep.Health).Render(ep.Health.Label())}
	if ep.Reason != "" {
		lines = append(lines, m.styles.muted.Render(ep.Reason))
	}

	report := ep.Report
	if report == nil {
		lines = append(lines, "", m.styles.muted.Render("No verification has completed yet."))
		return m.clip(lines, height)
	}

	lines = append(lines,
		"",
		m.field("root", rootLabel(report)),
		m.field("observed TLS leaf", short(report.ObservedTLSFingerprint)),
		m.field("signed certFingerprint", short(report.CertFingerprint)),
		m.field("evidenceDigest", short(report.EvidenceDigest)+pinnedSuffix(m.styles, report)),
	)
	if report.QuoteFormat != "" {
		lines = append(lines, m.field("root CA TEE quote", report.QuoteFormat+" (not validated)"))
	}

	if len(report.Chain) > 0 {
		lines = append(lines, "", m.styles.label.Render("chain (leaf → root)"))
		for i, cert := range report.Chain {
			branch := "  ├─"
			if i == len(report.Chain)-1 {
				branch = "  └─"
			}
			lines = append(lines, fmt.Sprintf("%s %s  %s",
				branch, cert.Subject, m.styles.muted.Render(short(cert.Fingerprint))))
		}
	}

	if len(report.Images) > 0 {
		lines = append(lines, "", m.styles.label.Render("images"))
		for _, image := range report.Images {
			lines = append(lines, "  "+image)
		}
	}

	if len(report.Policies) > 0 {
		lines = append(lines, "", m.styles.label.Render("policies"))
		for _, decision := range report.Policies {
			name := decision.Policy
			if name == "" {
				name = "(built-in)"
			}
			verdict := m.styles.good.Render("allow")
			if !decision.Allow {
				verdict = m.styles.bad.Render("DENY")
			}
			if decision.Error != "" {
				verdict = m.styles.bad.Render("ERROR: " + decision.Error)
			}
			lines = append(lines, fmt.Sprintf("  %-24s %-28s %s", name, decision.Package, verdict))
		}
	}

	for _, warning := range report.Warnings {
		lines = append(lines, "", m.styles.warn.Render("! "+warning))
	}
	return m.clip(lines, height)
}

// logView renders the tail, newest last.
func (m Model) logView(height int) string {
	if len(m.logs) == 0 {
		return m.styles.muted.Render("No log lines yet.")
	}
	lines := make([]string, 0, height)
	start := maxInt(0, len(m.logs)-height)
	for _, line := range m.logs[start:] {
		stamp := m.styles.muted.Render(line.At.Format("15:04:05"))
		level := m.styles.levelStyle(line.Level).Render(fmt.Sprintf("%-5s", line.Level))
		where := m.styles.muted.Render(fmt.Sprintf("%-16s", line.Endpoint))
		lines = append(lines, truncate(fmt.Sprintf("%s %s %s %s", stamp, level, where, line.Message), m.contentWidth()))
	}
	return strings.Join(lines, "\n")
}

// statusBar shows the last action's result, or what the visible pane is.
func (m Model) statusBar() string {
	if m.flash != "" {
		style := m.styles.flash
		if m.flashError {
			style = m.styles.flashError
		}
		return style.Render(truncate(m.flash, m.width))
	}
	pane := "detail"
	if m.pane == paneLogs {
		pane = "logs"
	}
	line := fmt.Sprintf("showing %s · %d endpoint(s)", pane, len(m.snapshot.Endpoints))
	if m.events == nil {
		line += " · not receiving updates"
		return m.styles.warn.Render(truncate(line, m.width))
	}
	return m.styles.muted.Render(truncate(line, m.width))
}

func (m Model) field(label, value string) string {
	return truncate(m.styles.label.Render(fmt.Sprintf("%-24s", label))+m.styles.value.Render(value), m.contentWidth())
}

// clip trims a rendered pane to the height it was given, so a long chain never
// pushes the status bar off screen.
func (m Model) clip(lines []string, height int) string {
	for i := range lines {
		lines[i] = truncate(lines[i], m.contentWidth())
	}
	if height > 0 && len(lines) > height {
		lines = append(lines[:height-1:height-1], m.styles.muted.Render("…"))
	}
	return strings.Join(lines, "\n")
}

func rootLabel(r *status.Report) string {
	switch {
	case r.Root != "":
		return r.Root + "  " + short(r.RootFingerprint)
	case r.RootFingerprint != "":
		return short(r.RootFingerprint) + " — not trusted"
	default:
		return "—"
	}
}

func pinnedSuffix(s styles, r *status.Report) string {
	if r.EvidenceDigest == "" {
		return ""
	}
	if r.Pinned {
		return s.good.Render("  pinned")
	}
	return s.warn.Render("  not pinned")
}

// short abbreviates a fingerprint to something that fits a pane.
func short(digest string) string {
	body := strings.TrimPrefix(digest, "sha256/")
	if body == "" {
		return "—"
	}
	if len(body) <= 20 {
		return digest
	}
	return "sha256/" + body[:10] + "…" + body[len(body)-8:]
}

// truncate shortens a rendered line to a display width, counting the printable
// characters rather than the bytes so styling does not confuse the arithmetic.
func truncate(s string, width int) string {
	if width <= 0 || lipgloss.Width(s) <= width {
		return s
	}
	runes := []rune(s)
	for len(runes) > 0 && lipgloss.Width(string(runes)) > width-1 {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + "…"
}

// relative renders an instant as an age.
func relative(now, then time.Time) string {
	if then.IsZero() {
		return "never"
	}
	d := now.Sub(then)
	switch {
	case d < time.Second:
		return "now"
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	default:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit && exp < 4; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%cB", float64(n)/float64(div), "KMGTP"[exp])
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
