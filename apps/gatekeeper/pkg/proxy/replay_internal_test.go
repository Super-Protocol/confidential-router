package proxy

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
)

// SUP-289: the first request after an idle gap rode a keep-alive connection the
// upstream gateway had already closed, and failed with a bare EOF. These tests
// drive the pool's round tripper directly, against connections whose staleness
// the test controls, because the real failure needs a remote close landing in
// the window between the pool handing a connection out and the first write —
// too narrow to hit on purpose over a real socket.

func TestIdleConnectionsAreDroppedBeforeAGatewayDropsThem(t *testing.T) {
	// The low end of the nginx family's keep-alive timeouts (60–75 s; 65 s is
	// the default, and the Swarm gateway measured 64 s). A pool that keeps an
	// idle connection longer than the remote does hands the next request a dead
	// connection.
	const gatewayKeepAliveFloor = 60 * time.Second
	if idleConnTimeout >= gatewayKeepAliveFloor {
		t.Fatalf("idleConnTimeout = %s, want it below the gateway keep-alive floor (%s)",
			idleConnTimeout, gatewayKeepAliveFloor)
	}
	p := newPool("router.example.test", 443, nil)
	if p.transport.IdleConnTimeout != idleConnTimeout {
		t.Errorf("transport IdleConnTimeout = %s, want %s", p.transport.IdleConnTimeout, idleConnTimeout)
	}
}

// replayUpstream is a TLS HTTP/1.1 server that records every request it
// received in full, plus a dialer whose connections can be turned stale.
type replayUpstream struct {
	server *httptest.Server

	mu          sync.Mutex
	bodies      []string
	credentials []string
	conns       []*staleableConn
	dials       atomic.Int32
	failDial    atomic.Int32 // dials still to fail before one succeeds
}

func newReplayUpstream(t *testing.T, handler http.HandlerFunc) *replayUpstream {
	t.Helper()
	u := &replayUpstream{}
	u.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		u.bodies = append(u.bodies, string(body))
		u.credentials = append(u.credentials, r.Header.Get("Authorization"))
		u.mu.Unlock()
		if handler != nil {
			handler(w, r)
			return
		}
		_, _ = io.WriteString(w, "ok")
	}))
	u.server.StartTLS()
	t.Cleanup(u.server.Close)
	return u
}

func (u *replayUpstream) dial(ctx context.Context, network, _ string) (net.Conn, error) {
	u.dials.Add(1)
	if u.failDial.Add(-1) >= 0 {
		// What a gateway that aborts the handshake looks like from the client.
		return nil, io.EOF
	}
	raw, err := (&net.Dialer{}).DialContext(ctx, network, u.server.Listener.Addr().String())
	if err != nil {
		return nil, err
	}
	conn := &staleableConn{Conn: raw}
	u.mu.Lock()
	u.conns = append(u.conns, conn)
	u.mu.Unlock()
	return conn, nil
}

// goStale marks every connection dialled so far as closed by the remote.
func (u *replayUpstream) goStale() {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, conn := range u.conns {
		conn.stale.Store(true)
	}
}

func (u *replayUpstream) received() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.bodies...)
}

// presented is the `Authorization` header of every request the upstream read.
func (u *replayUpstream) presented() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.credentials...)
}

// staleableConn is a raw upstream connection that can be turned into one the
// remote has closed but this side has not noticed yet: it still looks alive to
// the pool, and its first write fails without a byte reaching the peer.
type staleableConn struct {
	net.Conn
	stale atomic.Bool
}

func (c *staleableConn) Write(b []byte) (int, error) {
	if c.stale.Load() {
		_ = c.Close()
		return 0, &net.OpError{Op: "write", Net: "tcp", Err: syscall.ECONNRESET}
	}
	return c.Conn.Write(b)
}

func post(t *testing.T, rt http.RoundTripper, u *replayUpstream, body string) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
		u.server.URL+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", replayCredential)
	// What the reverse proxy hands the transport: a body it cannot rewind.
	req.Body = io.NopCloser(req.Body)
	req.GetBody = nil
	return rt.RoundTrip(req)
}

func mustOK(t *testing.T, rt http.RoundTripper, u *replayUpstream, body string) string {
	t.Helper()
	resp, err := post(t, rt, u, body)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck // test cleanup
	answer, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading the response: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	return string(answer)
}

func TestAStaleKeepAliveConnectionFailsTheBareTransport(t *testing.T) {
	// The reproduction, pinned: without the replay this is the 502 users saw.
	u := newReplayUpstream(t, nil)
	p := newPool("router.example.test", 443, u.dial)
	mustOK(t, p.transport, u, `{"n":1}`)

	u.goStale()
	resp, err := post(t, p.transport, u, `{"n":2}`)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("the bare transport succeeded on a stale connection; the reproduction no longer reproduces")
	}
	if got := u.received(); len(got) != 1 {
		t.Errorf("upstream received %d requests, want only the first", len(got))
	}
}

func TestAStaleKeepAliveConnectionIsReplayedOnAFreshOne(t *testing.T) {
	u := newReplayUpstream(t, nil)
	p := newPool("router.example.test", 443, u.dial)
	var replays []error
	p.roundTripper.onReplay = func(err error) { replays = append(replays, err) }

	mustOK(t, p.roundTripper, u, `{"n":1}`)
	u.goStale()
	if body := mustOK(t, p.roundTripper, u, `{"n":2}`); body != "ok" {
		t.Errorf("body = %q, want the upstream's answer", body)
	}

	if got := u.received(); len(got) != 2 || got[1] != `{"n":2}` {
		t.Errorf("upstream received %q, want each request exactly once, intact", got)
	}
	if len(replays) != 1 {
		t.Errorf("replays = %v, want exactly one", replays)
	}
	if dials := u.dials.Load(); dials != 2 {
		t.Errorf("dials = %d, want the replay on a fresh connection", dials)
	}
}

// replayCredential stands in for the end-to-end API key every request on this
// path carries. The gatekeeper never reads it; it only has to not lose it.
const replayCredential = "Bearer sk-tee-v1-0123456789abcdef"

// TestAReplayCarriesTheCredential pins SUP-326 on the one path that builds a
// second request: a replay that reached the upstream without the key would make
// the router answer "Incorrect API key provided" for a key that is correct —
// the exact shape a tester reported, and indistinguishable from a bad key.
func TestAReplayCarriesTheCredential(t *testing.T) {
	u := newReplayUpstream(t, nil)
	p := newPool("router.example.test", 443, u.dial)

	mustOK(t, p.roundTripper, u, `{"n":1}`)
	u.goStale()
	mustOK(t, p.roundTripper, u, `{"n":2}`)

	presented := u.presented()
	if len(presented) != 2 {
		t.Fatalf("upstream read %d requests, want 2", len(presented))
	}
	for i, got := range presented {
		if got != replayCredential {
			t.Errorf("attempt %d presented %q, want %q", i+1, got, replayCredential)
		}
	}
}

func TestAReplayResendsALargeBodyFromItsFirstByte(t *testing.T) {
	// Larger than the transport's write buffer and than the replay limit: the
	// failed attempt consumed part of the body before its first write failed,
	// and the replay must still send all of it, in order.
	large := strings.Repeat("0123456789abcdef", (1<<20)/16)
	u := newReplayUpstream(t, nil)
	p := newPool("router.example.test", 443, u.dial)

	mustOK(t, p.roundTripper, u, "warm")
	u.goStale()
	mustOK(t, p.roundTripper, u, large)

	got := u.received()
	if len(got) != 2 || got[1] != large {
		t.Fatalf("upstream received %d requests (last %d bytes), want the large body once, intact",
			len(got), len(got[len(got)-1]))
	}
}

func TestARequestThatReachedTheUpstreamIsNeverReplayed(t *testing.T) {
	// The upstream read the whole request and then dropped the connection
	// without answering: it may have started a generation, so a second send
	// would run it twice.
	u := newReplayUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		conn, _, err := http.NewResponseController(w).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	})
	p := newPool("router.example.test", 443, u.dial)
	p.roundTripper.onReplay = func(err error) { t.Errorf("replayed after the upstream took the request: %v", err) }

	resp, err := post(t, p.roundTripper, u, `{"n":1}`)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("want the failure surfaced")
	}
	if got := u.received(); len(got) != 1 {
		t.Errorf("upstream received %d requests, want exactly one", len(got))
	}
}

func TestAStreamThatBreaksMidResponseIsNeverReplayed(t *testing.T) {
	u := newReplayUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		rc := http.NewResponseController(w)
		_ = rc.Flush()
		if conn, _, err := rc.Hijack(); err == nil {
			_ = conn.Close()
		}
	})
	p := newPool("router.example.test", 443, u.dial)
	p.roundTripper.onReplay = func(err error) { t.Errorf("replayed a stream already under way: %v", err) }

	resp, err := post(t, p.roundTripper, u, `{"stream":true}`)
	if err != nil {
		t.Fatalf("the headers arrived, want a response: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck // test cleanup
	if _, err := io.ReadAll(resp.Body); err == nil {
		t.Error("want the broken stream to surface as a read error")
	}
	if got := u.received(); len(got) != 1 {
		t.Errorf("upstream received %d requests, want exactly one", len(got))
	}
}

func TestAFailedHandshakeIsRetriedOnce(t *testing.T) {
	u := newReplayUpstream(t, nil)
	p := newPool("router.example.test", 443, u.dial)

	u.failDial.Store(1)
	mustOK(t, p.roundTripper, u, `{"n":1}`)
	if got := u.received(); len(got) != 1 {
		t.Errorf("upstream received %d requests, want exactly one", len(got))
	}

	// Once, not until it works: a gateway that keeps refusing is reported.
	p.transport.CloseIdleConnections()
	u.failDial.Store(2)
	resp, err := post(t, p.roundTripper, u, `{"n":2}`)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("want the second failed handshake surfaced")
	}
	if got := u.received(); len(got) != 1 {
		t.Errorf("upstream received %d requests, want none from the refused one", len(got))
	}
}

func TestACertificateMismatchIsNotReplayed(t *testing.T) {
	u := newReplayUpstream(t, nil)
	p := newPool("router.example.test", 443, u.dial)
	p.setPin(attestation.SHA256Fingerprint([]byte("the attested certificate")))

	resp, err := post(t, p.roundTripper, u, `{"n":1}`)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("want the mismatch surfaced")
	}
	var mismatch *leafMismatchError
	if !errors.As(err, &mismatch) {
		t.Errorf("err = %v, want the leaf mismatch itself, so the handler answers it as a denial", err)
	}
	if dials := u.dials.Load(); dials != 1 {
		t.Errorf("dials = %d, want a denial to be final", dials)
	}
}

func TestReplayBodyRewindsUntilItOverflows(t *testing.T) {
	src := bytes.Repeat([]byte("x"), replayBufferLimit+1)
	body := newReplayBody(io.NopCloser(bytes.NewReader(src)))

	first := body.view()
	head := make([]byte, 100)
	if _, err := io.ReadFull(first, head); err != nil {
		t.Fatal(err)
	}
	if !body.rewindable() {
		t.Fatal("a body read within the limit must be rewindable")
	}

	second := body.view()
	if _, err := first.Read(head); !errors.Is(err, errAttemptAbandoned) {
		t.Errorf("superseded view read err = %v, want it refused", err)
	}
	all, err := io.ReadAll(second)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(all, src) {
		t.Errorf("the new view read %d bytes, want the whole body from the start", len(all))
	}
	if body.rewindable() {
		t.Error("a body read past the limit must no longer be rewindable")
	}
	if newReplayBody(http.NoBody) != nil || !(*replayBody)(nil).rewindable() {
		t.Error("a request without a body is always replayable")
	}
}
