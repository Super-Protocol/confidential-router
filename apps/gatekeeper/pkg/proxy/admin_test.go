package proxy_test

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/proxy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// observable is the admitted stack with an admin socket and an audit log, which
// is what the status API and the audit tests both need.
func observable(t *testing.T) (*proxy.Supervisor, *fakeUpstream, *config.Config, string) {
	t.Helper()
	pki := newPKI(t)
	digest := digestOf("observable deployment")
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: digest,
	}))
	dir := t.TempDir()
	socket := filepath.Join(dir, "gatekeeper.sock")
	cfg := writeConfig(t, dir, configSpec{
		roots:       map[string]string{"test-root": pki.rootPEM},
		endpoints:   []endpointSpec{{name: "router", listen: freePort(t), pins: []string{digest}}},
		adminSocket: socket,
		auditFile:   "audit.jsonl",
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	awaitHealth(t, supervisor, "router", status.Confidential)
	return supervisor, upstream, cfg, socket
}

func TestAdminSocketAnswersTheStatusAPI(t *testing.T) {
	_, _, _, socket := observable(t)

	client, err := proxy.NewClient("unix:" + socket)
	if err != nil {
		t.Fatalf("building the client: %v", err)
	}

	health, err := client.Ping(t.Context())
	if err != nil {
		t.Fatalf("/healthz: %v", err)
	}
	if health.Status != "ok" || health.Endpoints != 1 || health.Confidential != 1 {
		t.Errorf("health = %+v, want one confidential endpoint", health)
	}

	snapshot := client.Snapshot(t.Context())
	if err := client.Err(); err != nil {
		t.Fatalf("/status: %v", err)
	}
	ep, ok := snapshot.Endpoint("router")
	if !ok || ep.Health != status.Confidential {
		t.Fatalf("snapshot = %+v, want the endpoint the supervisor is running", snapshot)
	}
	// The client is a reader: it must not be able to change what the gatekeeper
	// trusts or carries.
	if err := client.Start(t.Context(), "router"); err != status.ErrUnavailable { //nolint:errorlint // sentinel identity is the assertion
		t.Errorf("Start = %v, want ErrUnavailable — the admin API is read-only", err)
	}

	verdicts, err := client.Verdicts(t.Context())
	if err != nil {
		t.Fatalf("/verdicts: %v", err)
	}
	if len(verdicts) != 1 || !verdicts[0].Admitted || verdicts[0].Report == nil {
		t.Errorf("verdicts = %+v, want the admitting verdict and its report", verdicts)
	}
	if verdicts[0].Report.EvidenceDigest == "" {
		t.Error("the verdict does not name the digest it was formed over")
	}

	// The same socket serves Prometheus, so a scrape needs no second listener.
	body := readUnix(t, socket, "/metrics")
	for _, want := range []string{
		"gatekeeper_requests_total", "gatekeeper_endpoint_admitted", "gatekeeper_attestations_total",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("/metrics does not expose %s", want)
		}
	}
	if !strings.Contains(body, `gatekeeper_endpoint_admitted{endpoint="router"} 1`) {
		t.Error("/metrics does not report the endpoint as admitted")
	}
}

func TestMetricsCountRequestsAndVerdicts(t *testing.T) {
	supervisor, _, cfg, socket := observable(t)

	if resp := get(t, cfg.Endpoints[0].Listen, "/v1/models", nil); resp.status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", resp.status, resp.body)
	}
	if _, err := supervisor.Reattest(t.Context(), "router"); err != nil {
		t.Fatal(err)
	}

	body := readUnix(t, socket, "/metrics")
	for _, want := range []string{
		`gatekeeper_requests_total{endpoint="router",outcome="allowed"} 1`,
		`gatekeeper_attestations_total{endpoint="router",result="admitted"} 2`,
		`gatekeeper_endpoint_listening{endpoint="router"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("/metrics is missing %q\n%s", want, body)
		}
	}
	if !strings.Contains(body, "gatekeeper_request_ttfb_seconds_count") {
		t.Error("/metrics does not record time to first byte")
	}
	if !strings.Contains(body, `gatekeeper_bytes_total{direction="out",endpoint="router"}`) {
		t.Error("/metrics does not record proxied bytes")
	}
}

func TestAdminSocketIsReplacedWhenItIsStale(t *testing.T) {
	dir := t.TempDir()
	socket := filepath.Join(dir, "gatekeeper.sock")
	// A socket file left behind by a gatekeeper that was killed: nothing is
	// listening on it, and a restart has to be able to bind.
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	if err := stale.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(socket); err != nil {
		t.Fatalf("the stale socket was not left behind: %v", err)
	}

	pki := newPKI(t)
	digest := digestOf("restarted deployment")
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: digest,
	}))
	cfg := writeConfig(t, dir, configSpec{
		roots:       map[string]string{"test-root": pki.rootPEM},
		endpoints:   []endpointSpec{{name: "router", listen: freePort(t), pins: []string{digest}}},
		adminSocket: socket,
	})
	first := startSupervisor(t, cfg, upstream, nil)

	// While the first one holds it, a second gatekeeper must not silently take
	// the socket over.
	if _, err := proxy.New(t.Context(), proxy.Options{
		Config: cfg, Dial: upstream.dial, Verifier: verifierFor(upstream, nil),
	}); err == nil {
		t.Error("a second gatekeeper bound an admin socket that was already in use")
	}

	if err := first.Close(); err != nil {
		t.Fatalf("closing: %v", err)
	}
	if _, err := os.Stat(socket); !os.IsNotExist(err) {
		t.Errorf("the socket file survived a clean shutdown: %v", err)
	}
}

func TestVerdictsDocumentShapeIsStable(t *testing.T) {
	_, _, _, socket := observable(t)

	var raw []map[string]any
	body := readUnix(t, socket, "/verdicts")
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		t.Fatalf("/verdicts is not a JSON array (%v): %s", err, body)
	}
	if len(raw) != 1 {
		t.Fatalf("got %d verdicts, want 1", len(raw))
	}
	for _, key := range []string{"endpoint", "health", "admitted", "report"} {
		if _, ok := raw[0][key]; !ok {
			t.Errorf("/verdicts entry has no %q member: %v", key, raw[0])
		}
	}
}
