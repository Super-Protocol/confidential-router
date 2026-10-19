package proxy_test

import (
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/proxy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// pastTheRetryWindow is comfortably more than the on-demand retry window of
// ADR-003 §7, which is what a refused request's re-check is bounded by. The
// clock below is advanced by it rather than slept through.
const pastTheRetryWindow = 5 * time.Second

// clock is a manually advanced clock. The backoff arithmetic these tests are
// about is in seconds, and a test must not have to spend them.
type clock struct {
	mu sync.Mutex
	at time.Time
}

func newClock() *clock { return &clock{at: time.Now()} }

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(d)
}

// deniedEndpoint is the stack in the state SUP-422 is about: a fail-closed
// endpoint holding a denial, with a re-attestation interval far beyond the
// test's lifetime, so nothing but an on-demand re-check can clear it.
//
// deny shapes the first verdict; fix makes the upstream admissible again.
func deniedEndpoint(t *testing.T, failMode string) (
	s *proxy.Supervisor, u *fakeUpstream, listen string, c *clock, fix func(),
) {
	t.Helper()
	pki := newPKI(t)
	pinned := digestOf("the pinned deployment")
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: digestOf("something else"),
	}))
	cfg := writeConfig(t, t.TempDir(), configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{
			name: "router", listen: freePort(t), pins: []string{pinned}, failMode: failMode,
			// An hour of each: a verdict that changes inside this test did not
			// change because of the background loop or the verdict cache.
			reattestInterval: "1h", verdictCacheTTL: "1h",
		}},
	})
	clk := newClock()
	supervisor := startSupervisor(t, cfg, upstream, clk.now)
	broken := status.Broken
	if failMode == config.FailOpen {
		broken = status.NonConfidential
	}
	awaitHealth(t, supervisor, "router", broken)

	return supervisor, upstream, cfg.Endpoints[0].Listen, clk, func() {
		upstream.setBundle(buildBundle(t, bundleSpec{
			signer: pki.leaf, rootPEM: pki.rootPEM, digest: pinned,
		}))
	}
}

// TestARefusedRequestReattestsOnTheSpot is the defect of SUP-422: an endpoint
// that recovered seconds ago stayed refused until the next 5-minute tick,
// because no request triggered a re-check of the check that was refusing it.
func TestARefusedRequestReattestsOnTheSpot(t *testing.T) {
	supervisor, _, listen, clk, fix := deniedEndpoint(t, config.FailClosed)

	if resp := get(t, listen, "/v1/models", nil); resp.status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want the denial in force to refuse (%s)", resp.status, resp.body)
	}

	fix()
	clk.advance(pastTheRetryWindow)

	resp := get(t, listen, "/v1/models", nil)
	if resp.status != http.StatusOK {
		t.Fatalf("status = %d, want the request itself to have re-attested (%s)", resp.status, resp.body)
	}
	if ep, _ := supervisor.Snapshot(t.Context()).Endpoint("router"); ep.Health != status.Confidential {
		t.Errorf("health = %q, want the verdict the request produced to be the one in force", ep.Health)
	}
}

// TestRefusedRequestsDoNotHammerTheUpstream is the other half of the same
// behaviour: the re-check is on demand, not per request.
func TestRefusedRequestsDoNotHammerTheUpstream(t *testing.T) {
	_, upstream, listen, clk, _ := deniedEndpoint(t, config.FailClosed)
	settled := upstream.evidenceFetches()

	for range 5 {
		if resp := get(t, listen, "/v1/models", nil); resp.status != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503 (%s)", resp.status, resp.body)
		}
	}
	if got := upstream.evidenceFetches(); got != settled {
		t.Errorf("%d evidence fetches for requests inside the retry window, want none", got-settled)
	}

	clk.advance(pastTheRetryWindow)
	for range 5 {
		get(t, listen, "/v1/models", nil)
	}
	// One check for the first request past the window; the four behind it join
	// it or are inside the window of the verdict it installed.
	if got := upstream.evidenceFetches() - settled; got != 1 {
		t.Errorf("%d evidence fetches for five requests past the retry window, want 1", got)
	}
}

// TestAnUnreachableUpstreamIsNotAnAttestationFailure walks the measured
// scenario end to end: the upstream is cut off, the re-attestation that lands
// in the outage latches a denial, and the endpoint has to recover from it on a
// request rather than on the next tick. The wording the client gets in the
// meantime is the rest of SUP-422 — a code that does not claim a check failed,
// and a timestamp that dates the reason.
func TestAnUnreachableUpstreamIsNotAnAttestationFailure(t *testing.T) {
	supervisor, upstream, cfg := admitted(t, endpointSpec{
		name: "router", listen: freePort(t), reattestInterval: "1h", verdictCacheTTL: "1h",
	})
	listen := cfg.Endpoints[0].Listen

	upstream.block(true)
	if _, err := supervisor.Reattest(t.Context(), "router"); err != nil {
		t.Fatalf("re-attesting into the outage: %v", err)
	}
	awaitHealth(t, supervisor, "router", status.Broken)

	resp := get(t, listen, "/v1/models", nil)
	if resp.status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want the outage to fail closed (%s)", resp.status, resp.body)
	}
	denial := decodeDenial(t, resp.body)
	if denial.Stage != "fetch" {
		t.Errorf("stage = %q, want fetch (reason: %s)", denial.Stage, denial.Reason)
	}
	// Nothing failed attestation: the fetch never completed.
	if denial.Error.Code != "attestation_unreachable" {
		t.Errorf("code = %q, want attestation_unreachable for a network failure", denial.Error.Code)
	}
	if denial.CheckedAt == "" || resp.header.Get(proxy.CheckedAtHeader) == "" {
		t.Errorf("the denial is not dated (body %q, header %q), so a stale reason reads as a current one",
			denial.CheckedAt, resp.header.Get(proxy.CheckedAtHeader))
	}

	// The blip is over. The endpoint must not stay closed for the rest of the
	// re-attestation interval.
	upstream.block(false)
	deadline := time.Now().Add(15 * time.Second)
	for {
		resp = get(t, listen, "/v1/models", nil)
		if resp.status == http.StatusOK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("still %d after the upstream came back (%s)", resp.status, resp.body)
		}
		time.Sleep(200 * time.Millisecond)
	}
	if ep, _ := supervisor.Snapshot(t.Context()).Endpoint("router"); ep.Health != status.Confidential {
		t.Errorf("health = %q, want the endpoint admitted again", ep.Health)
	}
}

// TestADeniedFailOpenEndpointRecoversWithoutBlocking: under `failMode: open`
// traffic is flowing already, so the re-check must not be in the request's way
// — it runs behind it and upgrades the endpoint for the requests after.
func TestADeniedFailOpenEndpointRecoversWithoutBlocking(t *testing.T) {
	supervisor, _, listen, clk, fix := deniedEndpoint(t, config.FailOpen)

	resp := get(t, listen, "/v1/models", nil)
	if resp.status != http.StatusOK {
		t.Fatalf("status = %d, want fail-open to forward (%s)", resp.status, resp.body)
	}
	if verdict := resp.header.Get(proxy.VerdictHeader); !strings.HasPrefix(verdict, "deny ") {
		t.Errorf("%s = %q, want the unverified response still tagged", proxy.VerdictHeader, verdict)
	}

	fix()
	clk.advance(pastTheRetryWindow)
	if resp := get(t, listen, "/v1/models", nil); resp.status != http.StatusOK {
		t.Fatalf("status = %d, want the request forwarded while the re-check runs (%s)", resp.status, resp.body)
	}
	ep := awaitHealth(t, supervisor, "router", status.Confidential)
	if !ep.Health.Trusted() {
		t.Errorf("health = %q, want the background re-check to have admitted the endpoint", ep.Health)
	}
}
