package tui

import (
	"context"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

func TestDashboardShowsEveryEndpointAndTheSelectedReport(t *testing.T) {
	broken := confidentialEndpoint("qwen25-72b")
	broken.Health = status.Broken
	broken.Reason = "the chain terminates in an untrusted root"
	broken.Report.Verified, broken.Report.Admitted = false, false

	m := newModel(t, newFakeSupervisor(confidentialEndpoint("llama-33-70b"), broken))
	view := m.View()

	for _, want := range []string{
		"llama-33-70b", "qwen25-72b",
		"confidential", "broken",
		// The detail pane is about the selected endpoint.
		"swarm-cloud-prod", "gatekeeper.default", "ghcr.io/super-protocol/vllm@sha256:aaaa",
		// And the header counts what is on screen.
		"1 confidential", "1 broken",
	} {
		if !strings.Contains(view, want) {
			t.Errorf("view does not contain %q:\n%s", want, view)
		}
	}
}

func TestMovingTheCursorChangesTheDetailPane(t *testing.T) {
	m := newModel(t, newFakeSupervisor(confidentialEndpoint("llama-33-70b"), confidentialEndpoint("qwen25-72b")))

	if selected, _ := m.selected(); selected.Name != "llama-33-70b" {
		t.Fatalf("initial selection = %q, want the first endpoint", selected.Name)
	}
	m = press(t, m, "down")
	selected, ok := m.selected()
	if !ok || selected.Name != "qwen25-72b" {
		t.Fatalf("selection after ↓ = %q, want the second endpoint", selected.Name)
	}
	if !strings.Contains(m.View(), "qwen25-72b.tee.swarm.cloud") {
		t.Error("the detail pane did not follow the cursor")
	}
}

func TestSnapshotsKeepTheCursorOnTheSameEndpoint(t *testing.T) {
	supervisor := newFakeSupervisor(
		confidentialEndpoint("a-llama"), confidentialEndpoint("b-qwen"), confidentialEndpoint("c-mistral"))
	m := newModel(t, supervisor)
	m = press(t, m, "down")
	m = press(t, m, "down")

	// The first endpoint goes away — a reload, a removed endpoint. The cursor
	// must stay on what the user was looking at rather than on row 2, which is
	// how someone stops the wrong listener.
	m = update(m, snapshotMsg(status.Snapshot{
		At:        fixedNow,
		Endpoints: []status.Endpoint{confidentialEndpoint("b-qwen"), confidentialEndpoint("c-mistral")},
	}))

	selected, _ := m.selected()
	if selected.Name != "c-mistral" {
		t.Errorf("selection = %q, want it to have followed the endpoint", selected.Name)
	}
}

func TestStartAndStopFollowTheEndpointsState(t *testing.T) {
	stopped := confidentialEndpoint("llama-33-70b")
	stopped.Health = status.Stopped
	supervisor := newFakeSupervisor(stopped)
	m := newModel(t, supervisor)

	m = press(t, m, "s")
	if len(supervisor.started) != 1 || supervisor.started[0] != "llama-33-70b" {
		t.Fatalf("started = %v, want the stopped endpoint started", supervisor.started)
	}
	if !strings.Contains(m.flash, "started llama-33-70b") {
		t.Errorf("flash = %q, want the action confirmed", m.flash)
	}

	// Same key, running endpoint: the other direction.
	running := newFakeSupervisor(confidentialEndpoint("llama-33-70b"))
	m = press(t, newModel(t, running), "s")
	if len(running.stopped) != 1 {
		t.Fatalf("stopped = %v, want the running endpoint stopped", running.stopped)
	}
}

func TestReattestReportsADenial(t *testing.T) {
	supervisor := newFakeSupervisor(confidentialEndpoint("llama-33-70b"))
	supervisor.reattestReport = &status.Report{
		Verified: true, Admitted: false,
		Policies: []status.PolicyResult{{Package: "gatekeeper.default", Allow: false}},
	}
	m := press(t, newModel(t, supervisor), "r")

	if len(supervisor.reattest) != 1 {
		t.Fatalf("reattest = %v, want one re-check", supervisor.reattest)
	}
	// A re-attestation that came back denied must not read like a success.
	if !m.flashError || !strings.Contains(m.flash, "denied") {
		t.Errorf("flash = %q (error=%v), want the denial surfaced", m.flash, m.flashError)
	}
}

func TestFlashesExpire(t *testing.T) {
	now := fixedNow
	supervisor := newFakeSupervisor(confidentialEndpoint("llama-33-70b"))
	m := newModel(t, supervisor, func(o *Options) { o.Now = func() time.Time { return now } })

	m = press(t, m, "r")
	if m.flash == "" {
		t.Fatal("no flash after an action")
	}
	now = now.Add(flashFor + time.Second)
	m = update(m, tickMsg(now))
	if m.flash != "" {
		t.Errorf("flash = %q, want it cleared once it expired", m.flash)
	}
}

func TestTrustThisDeploymentRefusesWithoutAWritableConfig(t *testing.T) {
	m := press(t, newModel(t, newFakeSupervisor(confidentialEndpoint("llama-33-70b"))), "t")
	if !m.flashError || !strings.Contains(m.flash, "not writable") {
		t.Errorf("flash = %q (error=%v), want a refusal", m.flash, m.flashError)
	}
}

func TestTrustThisDeploymentRefusesAnUnverifiedEndpoint(t *testing.T) {
	unverified := confidentialEndpoint("llama-33-70b")
	unverified.Report.Verified, unverified.Report.Admitted = false, false
	unverified.Health = status.Broken

	// A digest published by an endpoint that failed the cryptographic stages is
	// not evidence of anything, and one keystroke is exactly where that would
	// otherwise be lost.
	m := press(t, newModel(t, newFakeSupervisor(unverified), withStore(t)), "t")
	if !m.flashError || !strings.Contains(m.flash, "has not passed verification") {
		t.Errorf("flash = %q (error=%v), want a refusal to pin", m.flash, m.flashError)
	}
}

func TestAddTheUntrustedRootNeedsAValidatedChain(t *testing.T) {
	endpoint := confidentialEndpoint("llama-33-70b")
	endpoint.Health = status.Broken
	// A report from a chain that never validated carries no certificate to
	// offer, however untrusted its terminus looked.
	endpoint.Report.UntrustedRoot = "sha256/whatever"

	m := press(t, newModel(t, newFakeSupervisor(endpoint), withStore(t)), "a")
	if !m.flashError || !strings.Contains(m.flash, "did not present a root") {
		t.Errorf("flash = %q (error=%v), want a refusal", m.flash, m.flashError)
	}
}

func TestAddTheUntrustedRootTakesTwoPresses(t *testing.T) {
	endpoint := confidentialEndpoint("llama-33-70b")
	endpoint.Health = status.Broken
	endpoint.Report.Verified, endpoint.Report.Admitted = false, false
	endpoint.Report.Stage = "untrusted-root"
	endpoint.Report.UntrustedRoot = untrustedRootFingerprint(t)
	endpoint.Report.UntrustedRootPEM = untrustedRootPEM(t)

	m := newModel(t, newFakeSupervisor(endpoint), withStore(t))
	store := m.opts.Store
	before := len(store.Roots())

	// A trusted root is global, so one stray keystroke must not widen trust for
	// every endpoint at once.
	m = press(t, m, "a")
	if !strings.Contains(m.flash, "press a again") {
		t.Fatalf("flash = %q, want a confirmation prompt", m.flash)
	}
	if len(store.Roots()) != before {
		t.Fatal("the first press already trusted the root")
	}

	m = press(t, m, "a")
	if m.flashError {
		t.Fatalf("flash = %q, want the root trusted", m.flash)
	}
	if len(store.Roots()) != before+1 {
		t.Error("the second press did not trust the root")
	}
}

func TestAnotherKeyCancelsTheRootConfirmation(t *testing.T) {
	endpoint := confidentialEndpoint("llama-33-70b")
	endpoint.Health = status.Broken
	endpoint.Report.UntrustedRoot = untrustedRootFingerprint(t)
	endpoint.Report.UntrustedRootPEM = untrustedRootPEM(t)

	m := newModel(t, newFakeSupervisor(endpoint), withStore(t))
	store := m.opts.Store
	before := len(store.Roots())

	m = press(t, m, "a")
	m = press(t, m, "j") // anything else at all
	m = press(t, m, "a") // back to asking, not doing
	if !strings.Contains(m.flash, "press a again") {
		t.Errorf("flash = %q, want the confirmation to have been cancelled", m.flash)
	}
	if len(store.Roots()) != before {
		t.Error("a cancelled confirmation still trusted the root")
	}
}

func TestPaneAndHelpKeys(t *testing.T) {
	m := newModel(t, newFakeSupervisor(confidentialEndpoint("llama-33-70b")))
	m = update(m, logMsg(status.LogLine{At: fixedNow, Level: "warn", Endpoint: "llama-33-70b", Message: "re-attesting"}))

	if strings.Contains(m.View(), "re-attesting") {
		t.Error("the log tail is visible before it was asked for")
	}
	m = press(t, m, "l")
	if !strings.Contains(m.View(), "re-attesting") {
		t.Error("`l` did not show the log tail")
	}
	m = press(t, m, "l")
	if m.pane != paneDetail {
		t.Error("`l` does not toggle back to the detail pane")
	}

	m = press(t, m, "?")
	if !m.showHelp {
		t.Error("`?` did not open the help")
	}
	// The expanded help must not push the table off screen.
	if !strings.Contains(m.View(), "llama-33-70b") {
		t.Error("opening the help hid the endpoints table")
	}
}

func TestQuitting(t *testing.T) {
	m := newModel(t, newFakeSupervisor(confidentialEndpoint("llama-33-70b")))
	next, cmd := m.Update(keyMsg("q"))
	if cmd == nil {
		t.Fatal("q produced no command")
	}
	if _, isQuit := cmd().(tea.QuitMsg); !isQuit {
		t.Error("q does not quit")
	}
	if view := next.(Model).View(); view != "" {
		t.Errorf("view on the way out = %q, want the screen released", view)
	}
}

func TestTheDashboardFitsASmallTerminal(t *testing.T) {
	m := newModel(t, newFakeSupervisor(
		confidentialEndpoint("llama-33-70b"), confidentialEndpoint("qwen25-72b")))

	for _, size := range []tea.WindowSizeMsg{{Width: 80, Height: 24}, {Width: 60, Height: 14}, {Width: 200, Height: 60}} {
		resized := update(m, size)
		view := resized.View()
		// Whatever else is dropped, the endpoints stay: that is the dashboard.
		// The name may be elided at narrow widths; its start may not.
		if !strings.Contains(view, "llama") {
			t.Errorf("%dx%d: the endpoints table disappeared:\n%s", size.Width, size.Height, view)
		}
		for i, line := range strings.Split(view, "\n") {
			if width := len([]rune(line)); width > size.Width+2 {
				t.Errorf("%dx%d: line %d is %d columns wide:\n%s", size.Width, size.Height, i, width, line)
			}
		}
		if height := len(strings.Split(view, "\n")); height > size.Height {
			t.Errorf("%dx%d: the view is %d lines tall", size.Width, size.Height, height)
		}
	}
}

func TestLosingTheEventStreamIsVisible(t *testing.T) {
	m := newModel(t, newFakeSupervisor(confidentialEndpoint("llama-33-70b")))
	m = update(m, subscribedMsg{events: make(chan status.Event)})
	m = update(m, eventsEndedMsg{})

	// A dashboard that quietly stops updating is worse than one that says so.
	if !strings.Contains(m.View(), "not receiving updates") {
		t.Errorf("view does not report the lost stream:\n%s", m.View())
	}
}

func TestQuittingReleasesTheEventSubscription(t *testing.T) {
	m := newModel(t, newFakeSupervisor(confidentialEndpoint("llama-33-70b")))

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	m = update(m, subscribedMsg{events: make(chan status.Event), cancel: cancel})

	next, _ := m.Update(keyMsg("q"))
	_ = next.(Model)
	// The supervisor must stop publishing into a channel nobody is reading.
	select {
	case <-ctx.Done():
	default:
		t.Error("quitting left the event subscription open")
	}
}

func TestTrustThisDeploymentPinsTheVerifiedDigest(t *testing.T) {
	endpoint := confidentialEndpoint("llama-33-70b")
	endpoint.Report.Pinned = false
	// The upstream has rolled since the verdict was formed: the published
	// digest passed nothing, and the verified one is stale. Pinning either
	// would be wrong.
	endpoint.PublishedDigest = "sha256/aLtGm_goUTIOw2B3g25z08lP4QaDrSX2K3Wai-B4Fpc"

	m := press(t, newModel(t, newFakeSupervisor(endpoint), withStore(t)), "t")
	if !m.flashError || !strings.Contains(m.flash, "re-attest") {
		t.Fatalf("flash = %q (error=%v), want a refusal pointing at re-attestation", m.flash, m.flashError)
	}

	// Once the two agree, the verified digest is what gets written.
	endpoint.PublishedDigest = endpoint.Report.EvidenceDigest
	m = newModel(t, newFakeSupervisor(endpoint), withStore(t))
	store := m.opts.Store
	m = press(t, m, "t")
	if m.flashError {
		t.Fatalf("flash = %q, want the digest pinned", m.flash)
	}
	ep, _ := store.Endpoint("llama-33-70b")
	if len(ep.Pins) != 1 {
		t.Fatalf("pins = %d, want the one already in the config (it is the same digest)", len(ep.Pins))
	}
}

func TestTheDashboardArmsOneStreamReaderAtATime(t *testing.T) {
	m := newModel(t, newFakeSupervisor(confidentialEndpoint("llama-33-70b")))

	// A snapshot the dashboard asked for itself must not arm a second reader:
	// one is already blocked on the stream, and every extra one would sit there
	// for the life of the process.
	_, cmd := m.Update(refreshedMsg(m.snapshot))
	if cmd != nil {
		t.Error("a self-requested snapshot armed another read of the event stream")
	}

	// And with no stream at all, nothing is armed — a receive from a nil
	// channel never returns.
	next, cmd := m.Update(snapshotMsg(m.snapshot))
	if _, ok := next.(Model); !ok || cmd != nil {
		t.Error("a snapshot armed a read with no subscription to read from")
	}

	withStream := update(m, subscribedMsg{events: make(chan status.Event)})
	if _, cmd := withStream.Update(snapshotMsg(m.snapshot)); cmd == nil {
		t.Error("a published snapshot did not re-arm the reader")
	}
}
