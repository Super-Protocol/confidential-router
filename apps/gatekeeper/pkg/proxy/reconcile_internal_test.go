package proxy

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// A listener can go away without anyone stopping the endpoint — the socket is
// closed under it, the accept loop fails, Serve returns. Before SUP-537 that
// was invisible: only stop() ever cleared `running`, so the endpoint went on
// reporting the verdict it last held while nothing was accepting connections,
// and the one state the dashboard and the console could not show was the one
// where the egress was dead. These tests drive it from inside the package
// because closing a listener out from under a running server is not something
// the public surface can ask for.

// deadVerifier is the verification seam reduced to nothing: these tests are
// about the listener, and a real verifier would only add a network fixture to
// the thing being measured.
func deadVerifier(context.Context, *config.Config) (status.Verifier, error) {
	return verifierFunc(func(context.Context, status.VerifyRequest) (*status.Report, error) {
		return nil, errors.New("not reachable in this test")
	}), nil
}

type verifierFunc func(context.Context, status.VerifyRequest) (*status.Report, error)

func (f verifierFunc) Verify(ctx context.Context, req status.VerifyRequest) (*status.Report, error) {
	return f(ctx, req)
}

// listeningSupervisor is one endpoint on a free loopback port, started, with
// reconciliation under the test's control rather than on a tick.
func listeningSupervisor(t *testing.T) (*Supervisor, *endpoint, string) {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listen := probe.Addr().String()
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		Version: config.SchemaVersion,
		Endpoints: []config.Endpoint{{
			Name: "router", Listen: listen, Upstream: "https://router.example.test",
		}},
	}
	s, err := New(t.Context(), Options{
		Config:          cfg,
		Verifier:        deadVerifier,
		PublishInterval: time.Hour,
		// Off: every reconciliation in these tests is one the test asked for,
		// so a failure is never a race with a ticker.
		ReconcileInterval: -1,
	})
	if err != nil {
		t.Fatalf("building the supervisor: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	if err := s.Start(t.Context(), "router"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	ep, err := s.endpoint("router")
	if err != nil {
		t.Fatal(err)
	}
	return s, ep, listen
}

func TestAListenerThatDiesIsReportedAndRebound(t *testing.T) {
	s, ep, listen := listeningSupervisor(t)

	// The socket goes away under the running server, which is what Serve
	// returning anything but ErrServerClosed means.
	ep.mu.Lock()
	listener := ep.listener
	ep.mu.Unlock()
	if err := listener.Close(); err != nil {
		t.Fatalf("closing the listener: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for ep.isRunning() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if ep.isRunning() {
		t.Fatal("the endpoint still reports a running listener after Serve returned")
	}
	// Broken rather than stopped, and with the reason on it: `stopped` is what
	// an operator asked for, and reading one as the other is how SUP-537 stayed
	// unexplained for an afternoon.
	snapshot := ep.snapshot()
	if snapshot.Health != status.Broken {
		t.Errorf("health = %q, want %q", snapshot.Health, status.Broken)
	}
	if snapshot.Reason == "" {
		t.Error("reason is empty, want the error Serve returned")
	}

	// And the loop brings it back: the configuration still declares it.
	if restarted := s.reconcile(t.Context()); restarted != 1 {
		t.Fatalf("reconcile restarted %d endpoint(s), want 1", restarted)
	}
	if !ep.isRunning() {
		t.Fatal("the endpoint is still down after a reconcile")
	}
	conn, err := net.DialTimeout("tcp", listen, time.Second)
	if err != nil {
		t.Fatalf("the rebound listener does not accept connections: %v", err)
	}
	_ = conn.Close()
	if why := listenerFailure(ep); why != "" {
		t.Errorf("the endpoint still carries %q after a successful rebind", why)
	}
}

// listenerFailure is whichever of the two listener faults the endpoint is
// holding, so a test can say "it is no longer about the listener" without
// matching on a verdict's own reason.
func listenerFailure(e *endpoint) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.bindErr != "" {
		return "cannot bind: " + e.bindErr
	}
	if e.serveErr != "" {
		return "listener stopped: " + e.serveErr
	}
	return ""
}

func TestReconcileRetriesAnAddressItCannotBindYet(t *testing.T) {
	s, ep, listen := listeningSupervisor(t)

	// The listener dies and something else takes the address before the loop
	// gets to it. A retry that gave up here would be the production state again
	// — declared, not served, nothing trying — so the loop has to keep asking
	// without turning the log into one line per attempt.
	ep.mu.Lock()
	listener := ep.listener
	ep.mu.Unlock()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for ep.isRunning() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	squatter, err := net.Listen("tcp", listen)
	if err != nil {
		t.Fatalf("taking the address: %v", err)
	}

	if restarted := s.reconcile(t.Context()); restarted != 0 {
		t.Errorf("reconcile restarted %d endpoint(s) onto a taken address", restarted)
	}
	// Broken with the bind error on it, which is what reaches the console as
	// `lastReason`: a silent `stopped` is what this endpoint used to report.
	snapshot := ep.snapshot()
	if snapshot.Health != status.Broken {
		t.Errorf("health = %q, want %q while the address is taken", snapshot.Health, status.Broken)
	}
	if !strings.Contains(snapshot.Reason, "cannot bind") {
		t.Errorf("reason = %q, want it to name the bind failure", snapshot.Reason)
	}

	// The address frees up, and the next pass takes it — no restart, no human.
	if err := squatter.Close(); err != nil {
		t.Fatal(err)
	}
	if restarted := s.reconcile(t.Context()); restarted != 1 {
		t.Fatalf("reconcile restarted %d endpoint(s) once the address was free, want 1", restarted)
	}
	if why := listenerFailure(ep); why != "" {
		t.Errorf("the endpoint still carries %q after the bind succeeded", why)
	}
}

func TestAReloadStopsWantingTheEndpointsItRetired(t *testing.T) {
	s, ep, listen := listeningSupervisor(t)

	// The endpoint leaves the configuration — an admin disabling it, so
	// router-api renders it out. A reconcile pass that began before the swap
	// still holds this object; it must not bring the listener back, because the
	// address may be exactly what a replacement is about to bind.
	if err := s.Reload(t.Context(), &config.Config{Version: config.SchemaVersion}); err != nil {
		t.Fatalf("reloading: %v", err)
	}
	if ep.desired() {
		t.Error("a retired endpoint still reports that it wants to be serving")
	}
	if ep.isRunning() {
		t.Error("a retired endpoint is still running")
	}
	if restarted := s.reconcile(t.Context()); restarted != 0 {
		t.Errorf("reconcile restarted %d endpoint(s) after they were retired", restarted)
	}
	conn, err := net.DialTimeout("tcp", listen, 300*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		t.Error("the retired endpoint's address is still bound")
	}
}

func TestAnOperatorStartIsReportedEvenWhenItRepeats(t *testing.T) {
	s, ep, listen := listeningSupervisor(t)
	lines := bindFailureLines(t, s)

	if err := s.Stop(t.Context(), "router"); err != nil {
		t.Fatalf("stopping: %v", err)
	}
	squatter, err := net.Listen("tcp", listen)
	if err != nil {
		t.Fatalf("taking the address: %v", err)
	}
	t.Cleanup(func() { _ = squatter.Close() })

	// The loop asks a few times a minute for as long as the endpoint is
	// declared, and says so once.
	for range 3 {
		if err := ep.retry(t.Context()); err == nil {
			t.Fatal("binding a taken address should fail")
		}
	}
	if got := lines(); got != 1 {
		t.Errorf("the reconcile loop wrote %d bind-failure lines for one reason, want 1", got)
	}

	// An operator asking by name is owed an answer, repeat or not: a start key
	// that writes nothing looks like a command that did not run.
	if err := s.Start(t.Context(), "router"); err == nil {
		t.Fatal("binding a taken address should fail")
	}
	if got := lines(); got != 2 {
		t.Errorf("%d bind-failure lines after an operator start, want the operator's own line too", got)
	}
}

// bindFailureLines subscribes to the supervisor's log stream and returns a
// function reporting how many bind failures it has carried so far.
func bindFailureLines(t *testing.T, s *Supervisor) func() int {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	events := s.bus.subscribe(ctx)

	var mu sync.Mutex
	seen := 0
	go func() {
		for event := range events {
			if event.Kind == status.EventLog && event.Log != nil &&
				strings.Contains(event.Log.Message, "cannot bind") {
				mu.Lock()
				seen++
				mu.Unlock()
			}
		}
	}()
	return func() int {
		// The bus publishes asynchronously, so a count is only meaningful once
		// the lines in flight have landed.
		time.Sleep(100 * time.Millisecond)
		mu.Lock()
		defer mu.Unlock()
		return seen
	}
}
