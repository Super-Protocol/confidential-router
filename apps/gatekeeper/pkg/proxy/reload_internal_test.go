package proxy

import (
	"context"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// A reload changes the trust store and the policy set, so a verification that
// started before it answers a question that is no longer being asked. Nothing
// used to stop that answer from becoming the endpoint's verdict: the generation
// guard only moves when a listener starts or stops, and a reload keeps the
// listener running. For as long as such a verdict stood, the gatekeeper
// enforced the configuration the admin had just replaced — a withdrawn root
// still trusted, a freshly granted one still refused — and the endpoint
// reported a reason naming a trust list that no longer existed (SUP-442).
//
// These tests drive it from inside the package because holding a verification
// still across a reload is not something the public surface can ask for.

// heldVerifier is the verification seam with a hand on it: every check it is
// asked for announces itself on `started` and then waits to be released. Each
// answer names the trust store the verifier was built from, which is what makes
// "the verdict that landed came from the configuration we replaced" something a
// test can assert rather than infer from timing.
type heldVerifier struct {
	started chan *heldCheck
	// admit is what the checks answer. A denial is the shape SUP-442 was found
	// in; an admission is what a reload must not drop.
	admit atomic.Bool
}

type heldCheck struct {
	trust   string
	release chan struct{}
}

func newHeldVerifier() *heldVerifier {
	// Buffered, so a check never blocks on announcing itself — only on being
	// released, which is the hold the tests are after.
	return &heldVerifier{started: make(chan *heldCheck, 8)}
}

// factory is the [VerifierFunc] a supervisor is built with. It is called once
// per configuration, which is how each check comes to carry the name of the
// trust store it was formed against.
func (h *heldVerifier) factory() VerifierFunc {
	return func(_ context.Context, cfg *config.Config) (status.Verifier, error) {
		trust := trustStoreName(cfg)
		return verifierFunc(func(ctx context.Context, req status.VerifyRequest) (*status.Report, error) {
			check := &heldCheck{trust: trust, release: make(chan struct{})}
			select {
			case h.started <- check:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			select {
			case <-check.release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			report := &status.Report{
				Endpoint: req.Endpoint, Hostname: req.Hostname, Port: req.Port,
				CheckedAt: time.Now(), Admitted: h.admit.Load(), Verified: true,
				Root: trust,
			}
			if !report.Admitted {
				report.Stage = "policy"
				report.Reason = "no measurement is listed in " + trust
			}
			return report, nil
		}), nil
	}
}

// await takes the next check the pipeline started.
func (h *heldVerifier) await(t *testing.T) *heldCheck {
	t.Helper()
	select {
	case check := <-h.started:
		return check
	case <-time.After(10 * time.Second):
		t.Fatal("no verification started")
		return nil
	}
}

// releaseEvery lets go of every check from now on, for a test that is done
// holding them still.
func (h *heldVerifier) releaseEvery(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	go func() {
		for {
			select {
			case check := <-h.started:
				close(check.release)
			case <-ctx.Done():
				return
			}
		}
	}()
}

// trustStoreName reduces a configuration to the one thing these tests vary: the
// name of the trusted root it carries.
func trustStoreName(cfg *config.Config) string {
	if cfg == nil || len(cfg.TrustedRoots) == 0 {
		return "no roots"
	}
	return cfg.TrustedRoots[0].Name
}

// heldConfig is one endpoint on the given address, trusting the named root.
func heldConfig(listen, root string) *config.Config {
	return &config.Config{
		Version:      config.SchemaVersion,
		TrustedRoots: []config.TrustedRoot{{Name: root}},
		Endpoints: []config.Endpoint{{
			Name: "router", Listen: listen, Upstream: "https://router.example.test",
		}},
	}
}

// heldSupervisor is one started endpoint whose every verification is under the
// test's control, with both background loops out of the way: the reconcile one
// off, and the denied-endpoint retry schedule long enough that the only checks
// in the window are the ones the test caused.
func heldSupervisor(t *testing.T, held *heldVerifier, root string) (*Supervisor, *endpoint, string) {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listen := probe.Addr().String()
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := New(t.Context(), Options{
		Config:            heldConfig(listen, root),
		Verifier:          held.factory(),
		PublishInterval:   time.Hour,
		ReconcileInterval: -1,
		DenyBackoff:       time.Hour,
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

func TestAVerdictFormedBeforeAReloadIsNotInstalledAfterIt(t *testing.T) {
	held := newHeldVerifier()
	s, ep, listen := heldSupervisor(t, held, "oldRoots")

	// A check is in flight. Since SUP-422 a denied endpoint re-checks every
	// couple of seconds, so this is the state nearly every reload lands in.
	stale := held.await(t)
	if stale.trust != "oldRoots" {
		t.Fatalf("the check in flight was built from %q, want the configuration before the reload", stale.trust)
	}

	// An admin grants trust: router-api rewrites the file and the gatekeeper
	// reloads. The check in flight knows nothing about it.
	if err := s.Reload(t.Context(), heldConfig(listen, "newRoots")); err != nil {
		t.Fatalf("reloading: %v", err)
	}

	// Now it answers — against the trust store that no longer exists.
	close(stale.release)

	// What the reload's forced re-verification is built from is the proof that
	// the swap took: every check from here on sees the new configuration.
	fresh := held.await(t)
	if fresh.trust != "newRoots" {
		t.Fatalf("the check after the reload was built from %q, want the configuration now in force", fresh.trust)
	}
	// And this is the defect: that re-verification has not answered yet — it is
	// held, right here — so if the endpoint is carrying a verdict, it is the one
	// formed against the superseded configuration.
	if current := ep.current(); current != nil {
		t.Fatalf("a verdict formed before the reload was installed after it: %s (epoch %d)",
			current.Reason, current.epoch)
	}

	// The fresh one lands, and it is the one the endpoint enforces.
	close(fresh.release)
	current := awaitVerdict(t, ep)
	if !strings.Contains(current.Reason, "newRoots") {
		t.Errorf("the endpoint enforces %q, want a verdict formed against the configuration in force", current.Reason)
	}
}

// The single-flight guard is the other way a stale answer reaches a caller: a
// re-attestation asked for after the reload used to join the check already
// running and hand back whatever that one decided. Joining is still right —
// two checks against one upstream is what the guard exists to prevent — but the
// answer has to be the one the caller asked for.
func TestAReattestAfterAReloadDoesNotJoinACheckOlderThanIt(t *testing.T) {
	held := newHeldVerifier()
	s, ep, listen := heldSupervisor(t, held, "oldRoots")

	stale := held.await(t)
	if err := s.Reload(t.Context(), heldConfig(listen, "newRoots")); err != nil {
		t.Fatalf("reloading: %v", err)
	}

	// An operator's "re-attest now", arriving while the superseded check is
	// still in flight.
	reports := make(chan *status.Report, 1)
	go func() {
		report, err := s.Reattest(t.Context(), "router")
		if err != nil {
			t.Errorf("re-attesting: %v", err)
		}
		reports <- report
	}()

	// It joins the check in flight rather than opening a second one against the
	// upstream: nothing new starts until that one has answered.
	select {
	case check := <-held.started:
		t.Fatalf("a second check was started against the upstream while one was in flight (%s)", check.trust)
	case <-time.After(200 * time.Millisecond):
	}

	close(stale.release)
	held.releaseEvery(t)

	select {
	case report := <-reports:
		if report == nil {
			t.Fatal("re-attestation produced no report")
		}
		if report.Root != "newRoots" {
			t.Errorf("re-attestation answered from the %q configuration, want %q", report.Root, "newRoots")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("re-attestation never returned")
	}
	if current := awaitVerdict(t, ep); current.Report.Root != "newRoots" {
		t.Errorf("the endpoint enforces a verdict from the %q configuration", current.Report.Root)
	}
}

// The fix must not become "a reload clears the verdict". An endpoint whose
// listener survives a reload keeps serving the traffic its verdict admits until
// the re-verification lands — a SIGHUP that added a trusted root has no
// business dropping a completion that is halfway through streaming.
func TestAReloadKeepsTheVerdictInForceUntilTheFreshOneLands(t *testing.T) {
	held := newHeldVerifier()
	held.admit.Store(true)
	s, ep, listen := heldSupervisor(t, held, "oldRoots")

	first := held.await(t)
	close(first.release)
	admitted := awaitVerdict(t, ep)
	if !admitted.Admitted {
		t.Fatalf("the endpoint was not admitted to begin with: %s", admitted.Reason)
	}

	if err := s.Reload(t.Context(), heldConfig(listen, "newRoots")); err != nil {
		t.Fatalf("reloading: %v", err)
	}
	// The forced re-verification, held open: the window in which the endpoint
	// has nothing newer to go on than the verdict it already had.
	fresh := held.await(t)
	current := ep.current()
	if current == nil || !current.Admitted {
		t.Fatal("a reload dropped the verdict the listener was serving on")
	}
	close(fresh.release)
}

// awaitVerdict waits for a verdict to be in force and returns it.
func awaitVerdict(t *testing.T, e *endpoint) *verdict {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if current := e.current(); current != nil {
			return current
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no verdict was ever installed")
	return nil
}
