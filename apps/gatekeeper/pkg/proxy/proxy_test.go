package proxy_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/proxy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// admitted builds the whole stack in its good state: a mock upstream publishing
// a bundle whose digest the endpoint pins, and a running supervisor in front
// of it.
func admitted(t *testing.T, endpoints ...endpointSpec) (*proxy.Supervisor, *fakeUpstream, *config.Config) {
	t.Helper()
	pki := newPKI(t)
	digest := digestOf("admitted deployment")
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: digest,
	}))

	if len(endpoints) == 0 {
		endpoints = []endpointSpec{{name: "router", listen: freePort(t)}}
	}
	for i := range endpoints {
		if len(endpoints[i].pins) == 0 {
			endpoints[i].pins = []string{digest}
		}
	}
	cfg := writeConfig(t, t.TempDir(), configSpec{
		roots:     map[string]string{"test-root": pki.rootPEM},
		endpoints: endpoints,
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	awaitHealth(t, supervisor, endpoints[0].name, status.Confidential)
	return supervisor, upstream, cfg
}

func TestAdmittedTrafficStreamsChunkByChunk(t *testing.T) {
	supervisor, upstream, cfg := admitted(t)
	listen := cfg.Endpoints[0].Listen

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+listen+"/sse", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Accept", "text/event-stream")
	// A client must not be able to forge the gatekeeper's own header into the
	// router's view of the request.
	req.Header.Set(proxy.VerdictHeader, "allow forged")

	resp, err := localClient().Do(req)
	if err != nil {
		t.Fatalf("streaming request: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck // test

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get(proxy.VerdictHeader); got != "allow" {
		t.Errorf("%s = %q, want %q", proxy.VerdictHeader, got, "allow")
	}

	// The whole point of FlushInterval: -1. The upstream has written one event
	// and is waiting; a proxy that buffered would block here until the second
	// one arrives, which cannot happen until this read returns.
	reader := bufio.NewReader(resp.Body)
	first := readEvent(t, reader)
	if !strings.Contains(first, `"chunk":1`) {
		t.Fatalf("first chunk = %q, want the first event", first)
	}

	close(upstream.release)
	second := readEvent(t, reader)
	if !strings.Contains(second, `"chunk":2`) {
		t.Errorf("second chunk = %q, want the second event", second)
	}

	seen := upstream.seen()
	if len(seen) != 1 {
		t.Fatalf("upstream saw %d requests, want 1", len(seen))
	}
	// Everything the upstream must and must not have been told.
	if seen[0].Host != upstreamHost {
		t.Errorf("upstream Host = %q, want %q", seen[0].Host, upstreamHost)
	}
	if got := upstream.serverName(); got != upstreamHost {
		t.Errorf("upstream SNI = %q, want %q", got, upstreamHost)
	}
	for name := range seen[0].Header {
		if strings.HasPrefix(http.CanonicalHeaderKey(name), "X-Gatekeeper-") {
			t.Errorf("the upstream was sent %s: the router must never learn about the verdict", name)
		}
	}
	if seen[0].Header.Get("Accept") != "text/event-stream" {
		t.Error("the client's own headers did not survive the proxy")
	}

	if ep, _ := supervisor.Snapshot(t.Context()).Endpoint("router"); ep.BytesOut == 0 {
		t.Error("no response bytes were counted")
	}
}

// readEvent reads one `data: …\n\n` frame with a deadline, so a proxy that
// buffers fails the test instead of hanging it.
func readEvent(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	type result struct {
		line string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		line, err := reader.ReadString('\n')
		ch <- result{line, err}
	}()
	select {
	case got := <-ch:
		if got.err != nil {
			t.Fatalf("reading the stream: %v", got.err)
		}
		if strings.TrimSpace(got.line) == "" {
			return readEvent(t, reader)
		}
		return got.line
	case <-time.After(3 * time.Second):
		t.Fatal("no chunk arrived within 3s — the response is being buffered")
		return ""
	}
}

func TestFailClosedRefusesWhenTheChainIsUntrusted(t *testing.T) {
	pki := newPKI(t)
	digest := digestOf("untrusted deployment")
	// A well-formed bundle from a cloud whose root is not in the trust store.
	upstream := newUpstream(t, pki.foreignLeaf.cert, buildBundle(t, bundleSpec{
		signer: pki.foreignLeaf, rootPEM: pki.foreignRootPEM, digest: digest,
	}))
	cfg := writeConfig(t, t.TempDir(), configSpec{
		roots:     map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{name: "router", listen: freePort(t), pins: []string{digest}}},
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	awaitHealth(t, supervisor, "router", status.Broken)

	resp := get(t, cfg.Endpoints[0].Listen, "/v1/models", nil)
	body := resp.body
	if resp.status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body: %s)", resp.status, body)
	}

	denial := decodeDenial(t, body)
	if denial.Stage != "untrusted-root" {
		t.Errorf("stage = %q, want untrusted-root (reason: %s)", denial.Stage, denial.Reason)
	}
	if denial.Error.Type != "gatekeeper_error" || denial.Error.Code != "attestation_failed" {
		t.Errorf("error = %+v, want the OpenAI-shaped gatekeeper error of ADR-003 §6", denial.Error)
	}
	if !strings.HasPrefix(resp.header.Get(proxy.VerdictHeader), "deny untrusted-root") {
		t.Errorf("%s = %q, want the denial", proxy.VerdictHeader, resp.header.Get(proxy.VerdictHeader))
	}
	// Fail-closed does not open an upstream connection at all.
	if seen := upstream.seen(); len(seen) != 0 {
		t.Errorf("the upstream was contacted %d times by a fail-closed endpoint", len(seen))
	}
}

func TestFailClosedRefusesWhenTheDigestIsNotPinned(t *testing.T) {
	pki := newPKI(t)
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: digestOf("what the upstream publishes"),
	}))
	cfg := writeConfig(t, t.TempDir(), configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{
			name: "router", listen: freePort(t), pins: []string{digestOf("what the user pinned")},
		}},
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	ep := awaitHealth(t, supervisor, "router", status.Broken)

	// The cryptography was fine; the policy layer is what refused. That
	// distinction is the whole reason the report carries both.
	if ep.Report == nil || !ep.Report.Verified {
		t.Fatalf("report = %+v, want a cryptographically verified but unadmitted bundle", ep.Report)
	}
	denial := decodeDenial(t, get(t, cfg.Endpoints[0].Listen, "/v1/models", nil).body)
	if denial.Stage != "policy" {
		t.Errorf("stage = %q, want policy", denial.Stage)
	}
	if ep.PublishedDigest == "" {
		t.Error("the published digest is not reported, so the dashboard cannot offer to pin it")
	}
}

func TestFailOpenForwardsAndFlagsTheResponse(t *testing.T) {
	pki := newPKI(t)
	digest := digestOf("unpinned deployment")
	upstream := newUpstream(t, pki.foreignLeaf.cert, buildBundle(t, bundleSpec{
		signer: pki.foreignLeaf, rootPEM: pki.foreignRootPEM, digest: digest,
	}))
	cfg := writeConfig(t, t.TempDir(), configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{
			name: "router", listen: freePort(t), pins: []string{digest}, failMode: "open",
		}},
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	awaitHealth(t, supervisor, "router", status.NonConfidential)

	resp := get(t, cfg.Endpoints[0].Listen, "/v1/models", nil)
	body := resp.body
	if resp.status != http.StatusOK {
		t.Fatalf("status = %d, want the request forwarded (body: %s)", resp.status, body)
	}
	verdict := resp.header.Get(proxy.VerdictHeader)
	if !strings.HasPrefix(verdict, "deny ") {
		t.Errorf("%s = %q, want the response tagged as unverified", proxy.VerdictHeader, verdict)
	}
	if !strings.Contains(verdict, "untrusted-root") {
		t.Errorf("%s = %q, want it to name the stage that denied", proxy.VerdictHeader, verdict)
	}
	if len(upstream.seen()) != 1 {
		t.Error("fail-open did not forward the request")
	}
	// The traffic flows, and the dashboard must not call that confidential.
	if ep, _ := supervisor.Snapshot(t.Context()).Endpoint("router"); ep.Health.Trusted() {
		t.Error("a fail-open endpoint without a verdict is reported as trusted")
	}
}

func TestACertificateSwapFlipsTheVerdict(t *testing.T) {
	pki := newPKI(t)
	digest := digestOf("rotating deployment")
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: digest,
	}))
	cfg := writeConfig(t, t.TempDir(), configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{
			name: "router", listen: freePort(t), pins: []string{digest},
			// Short enough that the background loop, and the re-check the data
			// plane triggers on a certificate mismatch, both run inside the test.
			reattestInterval: "200ms", verdictCacheTTL: "100ms",
		}},
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	awaitHealth(t, supervisor, "router", status.Confidential)
	listen := cfg.Endpoints[0].Listen

	if resp := get(t, listen, "/v1/models", nil); resp.status != http.StatusOK {
		t.Fatalf("status = %d before the swap, want 200 (%s)", resp.status, resp.body)
	}

	// The upstream now presents a different certificate while still publishing
	// the bundle that commits to the old one.
	upstream.setCertificate(pki.rotated.cert)

	// Every connection opened under the old leaf is closed, so the next request
	// dials — and the dial is what refuses.
	deadline := time.Now().Add(10 * time.Second)
	var last reply
	var body string
	for time.Now().Before(deadline) {
		last = get(t, listen, "/v1/models", nil)
		body = last.body
		if last.status == http.StatusServiceUnavailable {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if last.status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d after the certificate swap, want 503", last.status)
	}
	if stage := decodeDenial(t, body).Stage; stage != "tls-fingerprint" {
		t.Errorf("stage = %q, want tls-fingerprint", stage)
	}

	// And the background re-attestation reaches the same conclusion, so the
	// dashboard shows the endpoint as broken rather than merely failing.
	ep := awaitHealth(t, supervisor, "router", status.Broken)
	if !strings.Contains(ep.Reason, "tls-fingerprint") {
		t.Errorf("reason = %q, want the channel binding named", ep.Reason)
	}
}

func TestWebSocketUpgradePassesThrough(t *testing.T) {
	_, _, cfg := admitted(t)

	conn, err := net.DialTimeout("tcp", cfg.Endpoints[0].Listen, 5*time.Second)
	if err != nil {
		t.Fatalf("dialling the listener: %v", err)
	}
	defer conn.Close() //nolint:errcheck // test
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}

	request := "GET /ws HTTP/1.1\r\nHost: " + upstreamHost + "\r\n" +
		"Connection: Upgrade\r\nUpgrade: websocket\r\n" +
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatal(err)
	}

	reader := bufio.NewReader(conn)
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("reading the upgrade response: %v", err)
	}
	if !strings.Contains(statusLine, "101") {
		t.Fatalf("status line = %q, want 101 Switching Protocols", statusLine)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(line) == "" {
			break
		}
	}

	// The connection is now raw in both directions.
	if _, err := io.WriteString(conn, "hello\n"); err != nil {
		t.Fatal(err)
	}
	echoed, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("reading the echo: %v", err)
	}
	if strings.TrimSpace(echoed) != "HELLO" {
		t.Errorf("echo = %q, want HELLO", echoed)
	}
}

func TestLargeBodiesRoundTripAndAreCounted(t *testing.T) {
	supervisor, _, cfg := admitted(t)

	payload := make([]byte, 3<<20) // 3 MiB, past any plausible buffer
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
		"http://"+cfg.Endpoints[0].Listen+"/echo", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := localClient().Do(req)
	if err != nil {
		t.Fatalf("posting: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck // test
	echoed, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, echoed) {
		t.Fatalf("the echoed body differs (%d bytes in, %d out)", len(payload), len(echoed))
	}

	ep, _ := supervisor.Snapshot(t.Context()).Endpoint("router")
	if ep.BytesIn < int64(len(payload)) {
		t.Errorf("bytesIn = %d, want at least %d", ep.BytesIn, len(payload))
	}
	if ep.BytesOut < int64(len(payload)) {
		t.Errorf("bytesOut = %d, want at least %d", ep.BytesOut, len(payload))
	}
}

func TestHopByHopHeadersDoNotReachTheUpstream(t *testing.T) {
	_, upstream, cfg := admitted(t)

	header := http.Header{}
	header.Set("Connection", "close, X-Private-Hop")
	header.Set("X-Private-Hop", "should not survive")
	header.Set("Proxy-Authorization", "Basic dXNlcjpwYXNz")
	header.Set("Authorization", "Bearer sk-tee-example")
	resp := get(t, cfg.Endpoints[0].Listen, "/v1/models", header)
	_ = resp.body

	seen := upstream.seen()
	if len(seen) != 1 {
		t.Fatalf("upstream saw %d requests, want 1", len(seen))
	}
	for _, name := range []string{"Connection", "Proxy-Authorization", "X-Private-Hop", "Keep-Alive"} {
		if got := seen[0].Header.Get(name); got != "" {
			t.Errorf("upstream received hop-by-hop header %s: %q", name, got)
		}
	}
	// The router's own credential is end-to-end and must pass untouched: the
	// gatekeeper never holds the API key (ADR-003 §8).
	if got := seen[0].Header.Get("Authorization"); got != "Bearer sk-tee-example" {
		t.Errorf("Authorization = %q, want the client's credential forwarded unchanged", got)
	}
}

func TestTheFirstRequestWaitsForTheFirstVerdict(t *testing.T) {
	pki := newPKI(t)
	digest := digestOf("slow deployment")
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: digest,
	}))
	cfg := writeConfig(t, t.TempDir(), configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{
			name: "router", listen: freePort(t), pins: []string{digest}, initialTimeout: "5s",
		}},
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)

	// No awaitHealth: this request races the very first attestation on purpose,
	// and must block on it rather than be refused for having no verdict yet.
	resp := get(t, cfg.Endpoints[0].Listen, "/v1/models", nil)
	body := resp.body
	if resp.status != http.StatusOK {
		t.Fatalf("status = %d, want the first request to wait for the verdict (body: %s)", resp.status, body)
	}
	if ep, _ := supervisor.Snapshot(t.Context()).Endpoint("router"); ep.Health != status.Confidential {
		t.Errorf("health = %q, want the verdict the request waited for", ep.Health)
	}
}

func TestStopAndStartTakeTheListenerDownAndBackUp(t *testing.T) {
	supervisor, _, cfg := admitted(t)
	listen := cfg.Endpoints[0].Listen

	if err := supervisor.Stop(t.Context(), "router"); err != nil {
		t.Fatalf("stopping: %v", err)
	}
	if _, err := net.DialTimeout("tcp", listen, 500*time.Millisecond); err == nil {
		t.Error("the listener is still accepting connections after Stop")
	}
	ep, _ := supervisor.Snapshot(t.Context()).Endpoint("router")
	if ep.Health != status.Stopped {
		t.Errorf("health = %q, want stopped", ep.Health)
	}

	if err := supervisor.Start(t.Context(), "router"); err != nil {
		t.Fatalf("restarting: %v", err)
	}
	awaitHealth(t, supervisor, "router", status.Confidential)
	if resp := get(t, listen, "/v1/models", nil); resp.status != http.StatusOK {
		t.Errorf("status = %d after restart, want 200 (%s)", resp.status, resp.body)
	}

	if err := supervisor.Start(t.Context(), "nope"); err == nil {
		t.Error("starting an unknown endpoint should be an error")
	}
}

func TestReattestBypassesTheVerdictCache(t *testing.T) {
	pki := newPKI(t)
	pinned := digestOf("pinned deployment")
	// The upstream starts out publishing something the endpoint does not pin.
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: digestOf("something else"),
	}))
	cfg := writeConfig(t, t.TempDir(), configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{
			name: "router", listen: freePort(t), pins: []string{pinned},
			// A long interval and a long TTL: only an explicit re-attestation
			// can change the verdict inside this test's lifetime.
			reattestInterval: "1h", verdictCacheTTL: "1h",
		}},
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	awaitHealth(t, supervisor, "router", status.Broken)

	upstream.setBundle(buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: pinned,
	}))
	report, err := supervisor.Reattest(t.Context(), "router")
	if err != nil {
		t.Fatalf("re-attesting: %v", err)
	}
	if !report.Admitted {
		t.Fatalf("report = %+v, want the fresh bundle admitted", report)
	}
	if ep, _ := supervisor.Snapshot(t.Context()).Endpoint("router"); ep.Health != status.Confidential {
		t.Errorf("health = %q, want the new verdict to be the one in force", ep.Health)
	}
}

func TestEventsCarrySnapshotsAndVerdictLines(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	pki := newPKI(t)
	digest := digestOf("watched deployment")
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: digest,
	}))
	cfg := writeConfig(t, t.TempDir(), configSpec{
		roots:     map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{name: "router", listen: freePort(t), pins: []string{digest}}},
	})

	supervisor, err := proxy.New(ctx, proxy.Options{
		Config: cfg, Dial: upstream.dial, PublishInterval: 50 * time.Millisecond,
		Verifier: verifierFor(upstream, nil),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer supervisor.Close() //nolint:errcheck // test

	events := supervisor.Events(ctx)
	if err := supervisor.Start(ctx, "router"); err != nil {
		t.Fatal(err)
	}

	var sawSnapshot, sawVerdictLine bool
	deadline := time.After(10 * time.Second)
	for !sawSnapshot || !sawVerdictLine {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatal("the event stream closed early")
			}
			switch {
			case event.Kind == status.EventSnapshot && event.Snapshot != nil:
				sawSnapshot = true
			case event.Kind == status.EventLog && event.Log != nil &&
				strings.Contains(event.Log.Message, "verdict allow"):
				sawVerdictLine = true
			}
		case <-deadline:
			t.Fatalf("snapshot=%v verdictLine=%v, want both", sawSnapshot, sawVerdictLine)
		}
	}

	// A subscription ends with its context, and the channel is closed rather
	// than left dangling.
	cancel()
	for range events { //nolint:revive // draining until close is the assertion
	}
}

func TestReloadKeepsRunningEndpointsAndAdoptsNewPins(t *testing.T) {
	pki := newPKI(t)
	published := digestOf("published deployment")
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: published,
	}))
	dir := t.TempDir()
	listen := freePort(t)
	cfg := writeConfig(t, dir, configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{
			name: "router", listen: listen, pins: []string{digestOf("the wrong digest")},
			reattestInterval: "1h", verdictCacheTTL: "1h",
		}},
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	awaitHealth(t, supervisor, "router", status.Broken)

	// The user pins what the upstream actually publishes and sends SIGHUP.
	reloaded := writeConfig(t, dir, configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{
			name: "router", listen: listen, pins: []string{published},
			reattestInterval: "1h", verdictCacheTTL: "1h",
		}},
	})
	if err := supervisor.Reload(t.Context(), reloaded); err != nil {
		t.Fatalf("reloading: %v", err)
	}

	// The listener never went down — the endpoint's spec did not change, only
	// what it trusts — and the verdict is re-formed against the new pins.
	awaitHealth(t, supervisor, "router", status.Confidential)
	if resp := get(t, listen, "/v1/models", nil); resp.status != http.StatusOK {
		t.Errorf("status = %d after reload, want 200 (%s)", resp.status, resp.body)
	}
}

func TestReloadRetiresAnEndpointThatIsGone(t *testing.T) {
	pki := newPKI(t)
	digest := digestOf("retired deployment")
	upstream := newUpstream(t, pki.leaf.cert, buildBundle(t, bundleSpec{
		signer: pki.leaf, rootPEM: pki.rootPEM, digest: digest,
	}))
	dir := t.TempDir()
	keep, drop := freePort(t), freePort(t)
	cfg := writeConfig(t, dir, configSpec{
		roots: map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{
			{name: "keep", listen: keep, pins: []string{digest}},
			{name: "drop", listen: drop, pins: []string{digest}},
		},
	})
	supervisor := startSupervisor(t, cfg, upstream, nil)
	awaitHealth(t, supervisor, "drop", status.Confidential)

	reloaded := writeConfig(t, dir, configSpec{
		roots:     map[string]string{"test-root": pki.rootPEM},
		endpoints: []endpointSpec{{name: "keep", listen: keep, pins: []string{digest}}},
	})
	if err := supervisor.Reload(t.Context(), reloaded); err != nil {
		t.Fatalf("reloading: %v", err)
	}

	snapshot := supervisor.Snapshot(t.Context())
	if _, ok := snapshot.Endpoint("drop"); ok {
		t.Error("the removed endpoint is still reported")
	}
	if _, err := net.DialTimeout("tcp", drop, 500*time.Millisecond); err == nil {
		t.Error("the removed endpoint's listener is still bound")
	}
	if ep, ok := snapshot.Endpoint("keep"); !ok || ep.Health != status.Confidential {
		t.Errorf("keep = %+v, want it still serving", ep)
	}
}

func TestUpstreamFailureIsABadGateway(t *testing.T) {
	supervisor, upstream, cfg := admitted(t)
	// The upstream goes away while the verdict stays valid: that is a broken
	// backend, not a denial, and must not be reported as one.
	if err := upstream.server.Close(); err != nil {
		t.Fatal(err)
	}
	_ = upstream.listener.Close()

	resp := get(t, cfg.Endpoints[0].Listen, "/v1/models", nil)
	body := resp.body
	if resp.status != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (body: %s)", resp.status, body)
	}
	if !strings.Contains(body, "upstream_unavailable") {
		t.Errorf("body = %s, want it to name the upstream as the problem", body)
	}
	if ep, _ := supervisor.Snapshot(t.Context()).Endpoint("router"); ep.Health != status.Confidential {
		t.Errorf("health = %q, want the verdict unaffected by a backend outage", ep.Health)
	}
}

func TestSupervisorRejectsAConfigItCannotRun(t *testing.T) {
	if _, err := proxy.New(t.Context(), proxy.Options{}); err == nil {
		t.Error("a supervisor was built without a configuration")
	}
}
