package proxy_test

import (
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// SUP-537: a parked production rollback answered on every surface an operator
// checks — evidence 200, console 200, sign-in working, `published: true` — and
// could not complete a single generation, because its one external endpoint sat
// at `PENDING` with `lastReason: "listener stopped"` and `lastCheckedAt` null.
// No listener was ever bound for it, so no verification was ever attempted, so
// nothing retried and nothing escalated. Twenty minutes of waiting, an
// enable/disable cycle, a price edit and a full pod roll all left it there.
//
// The defect behind it is not any one missed start. It is that every route into
// the data plane starts an endpoint at the moment it learns of it and nothing
// ever looks again: whoever got it wrong got it wrong for ever. These tests are
// about the standing answer instead — an endpoint the configuration declares
// does not stay down, whatever put it down.

// pastSeveralReconciles is long enough for the loop to have run several times
// at the testkit's 50 ms cadence, which is what "it stayed down" has to mean
// for an endpoint the loop deliberately leaves alone.
const pastSeveralReconciles = 400 * time.Millisecond

func TestAnEndpointTheConfigurationDeclaresDoesNotStayStopped(t *testing.T) {
	pki := newPKI(t)
	digest := digestOf("the parked deployment")
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: digest,
	}))
	dir := t.TempDir()
	serving, restored := freePort(t), freePort(t)
	cfg := writeConfig(t, dir, configSpec{
		roots:     map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{name: "serving", listen: serving, pins: []string{digest}}},
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	awaitHealth(t, supervisor, "serving", status.Confidential)

	// A name the running gatekeeper has never seen arrives in a reload — the
	// shape of every path that leaves an endpoint declared but unserved,
	// including the enable/disable cycle an operator reaches for first. Nobody
	// calls Start for it.
	reloaded := writeConfig(t, dir, configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{
			{name: "serving", listen: serving, pins: []string{digest}},
			{name: "restored", listen: restored, pins: []string{digest}},
		},
	})
	if err := supervisor.Reload(t.Context(), reloaded); err != nil {
		t.Fatalf("reloading: %v", err)
	}

	// Verified and serving, which is the check the production park never
	// passed: not "published and reachable" but a completion that returns 200.
	awaitHealth(t, supervisor, "restored", status.Confidential)
	if resp := get(t, restored, "/v1/models", nil); resp.status != http.StatusOK {
		t.Errorf("status = %d on the restored endpoint, want 200 (%s)", resp.status, resp.body)
	}
	// And a verdict was formed, so the row behind it carries a `lastCheckedAt`
	// rather than the null that made the production state unreadable.
	if ep, _ := supervisor.Snapshot(t.Context()).Endpoint("restored"); ep.LastAttestAt.IsZero() {
		t.Error("lastAttestAt is zero, want the verification the listener triggered")
	}
	if ep, _ := supervisor.Snapshot(t.Context()).Endpoint("serving"); ep.Health != status.Confidential {
		t.Errorf("serving = %q, want the endpoint that was already up left alone", ep.Health)
	}
}

func TestAnOperatorStoppedEndpointIsLeftStopped(t *testing.T) {
	supervisor, _, cfg := admitted(t)
	listen := cfg.Endpoints[0].Listen

	// The dashboard's stop key. It is the one state the reconcile loop must not
	// override: a configuration that names an endpoint is not an operator who
	// asked for it back.
	if err := supervisor.Stop(t.Context(), "router"); err != nil {
		t.Fatalf("stopping: %v", err)
	}
	time.Sleep(pastSeveralReconciles)

	if ep, _ := supervisor.Snapshot(t.Context()).Endpoint("router"); ep.Health != status.Stopped {
		t.Errorf("health = %q (%s), want it still stopped", ep.Health, ep.Reason)
	}
	if conn, err := net.DialTimeout("tcp", listen, 500*time.Millisecond); err == nil {
		_ = conn.Close()
		t.Error("the listener was brought back under an operator who stopped it")
	}

	// Starting it again is an operator asking for it, and the loop keeps it up
	// from then on.
	if err := supervisor.Start(t.Context(), "router"); err != nil {
		t.Fatalf("restarting: %v", err)
	}
	awaitHealth(t, supervisor, "router", status.Confidential)
}
