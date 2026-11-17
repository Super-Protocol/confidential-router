package proxy

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// A verdict and the pin the admitted pool holds have to become visible
// together. They did not: `attest` published the verdict and released its
// waiters, and only then moved the data plane, so a reader could see an
// admitted verdict while the pool was still pinned to "" from the denial before
// it — and go on to forward a request over a connection nothing was holding to
// the attested leaf, recorded as `allow`. The re-pin that followed then swept
// that connection, which is how the window showed up first as a `unexpected
// EOF` flake in TestLargeBodiesRoundTripAndAreCounted (SUP-428).
//
// The window is a handful of instructions wide, so these tests drive the two
// halves apart deliberately rather than racing them: pool.mu is the seam, since
// setPin cannot proceed without it and `attest` now holds endpoint.mu across
// both steps.

// recovery is the verification seam under the test's control: it denies until
// the test lets it admit, which is the deny→allow transition the ordering bug
// lived on.
type recovery struct {
	mu    sync.Mutex
	admit bool
	leaf  string
}

// verifier is the seam itself, reusing [verifierFunc] from the reconcile tests.
func (r *recovery) verifier() VerifierFunc {
	return func(context.Context, *config.Config) (status.Verifier, error) {
		return verifierFunc(func(context.Context, status.VerifyRequest) (*status.Report, error) {
			r.mu.Lock()
			admit, leaf := r.admit, r.leaf
			r.mu.Unlock()

			report := &status.Report{Endpoint: "router", Hostname: "router.example.test", Port: 443}
			if !admit {
				report.Stage, report.Reason = "fetch", "the upstream is not answering"
				return report, nil
			}
			report.Verified, report.Admitted = true, true
			report.ObservedTLSFingerprint = leaf
			return report, nil
		}), nil
	}
}

// allow is what the test calls to let the endpoint recover, pinning leaf.
func (r *recovery) allow(leaf string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.admit, r.leaf = true, leaf
}

// deniedEndpoint is one started endpoint holding a denial, with the verifier it
// will be allowed to recover through. Reconciliation and re-attestation are off:
// every check these tests see is one they asked for.
func deniedEndpoint(t *testing.T) (*endpoint, *recovery, string) {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listen := probe.Addr().String()
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}

	scripted := &recovery{}
	s, err := New(t.Context(), Options{
		Config: &config.Config{
			Version: config.SchemaVersion,
			Endpoints: []config.Endpoint{{
				Name: "router", Listen: listen, Upstream: "https://router.example.test",
			}},
		},
		Verifier:          scripted.verifier(),
		PublishInterval:   time.Hour,
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

	// The startup check has to have landed before a test drives the recovery,
	// or it would be racing the denial it means to recover from.
	select {
	case <-ep.firstVerdictClosed():
	case <-time.After(5 * time.Second):
		t.Fatal("the first verdict never landed")
	}
	if current := ep.current(); current == nil || current.Admitted {
		t.Fatalf("verdict = %v, want the denial the test recovers from", current)
	}
	if pin := ep.admittedPin(); pin != "" {
		t.Fatalf("the admitted pool is pinned to %q while the endpoint is denied", pin)
	}
	return ep, scripted, listen
}

// firstVerdictClosed exposes the first-verdict gate to a test without reaching
// through the lock that guards it.
func (e *endpoint) firstVerdictClosed() <-chan struct{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.firstVerdict
}

// admittedPin is the pin the admitted pool holds right now.
func (e *endpoint) admittedPin() string {
	e.admittedPool.mu.Lock()
	defer e.admittedPool.mu.Unlock()
	return e.admittedPool.pin
}

func TestAnAdmittedVerdictIsNotVisibleBeforeTheAdmittedPoolIsPinned(t *testing.T) {
	ep, scripted, _ := deniedEndpoint(t)
	leaf := attestation.SHA256Fingerprint([]byte("the recovered deployment's leaf"))
	scripted.allow(leaf)

	// Holding pool.mu stops the re-pin dead. Everything that may become visible
	// to a reader of the verdict has to be stuck behind it.
	ep.admittedPool.mu.Lock()

	installed := make(chan *verdict, 1)
	go func() { installed <- ep.attest(context.Background(), 0) }()

	// A reader racing the install: if it ever sees an admitted verdict while the
	// re-pin is blocked, the pool cannot be pinned — setPin is waiting on the
	// lock this test holds — and that is the window.
	leaked := make(chan struct{})
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			if current := ep.current(); current != nil && current.Admitted {
				close(leaked)
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()

	select {
	case <-leaked:
		ep.admittedPool.mu.Unlock()
		t.Fatal("an admitted verdict became visible while the admitted pool was still unpinned: " +
			"a request reading it would be forwarded as admitted over a connection " +
			"held to no attested certificate")
	case <-time.After(250 * time.Millisecond):
		// The publish is behind the pin, which is the invariant.
	}

	ep.admittedPool.mu.Unlock()
	select {
	case result := <-installed:
		if result == nil || !result.Admitted {
			t.Fatalf("verdict = %v, want the admitted one the verifier returned", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the attestation never finished after the pin was released")
	}

	// And once it is visible, the pool is already holding the leaf it was formed
	// over, so the next dial is bound to the attested channel.
	if pin := ep.admittedPin(); pin != leaf {
		t.Errorf("pin = %q, want the leaf the verdict observed (%q)", pin, leaf)
	}
}

func TestTheAdmittedPoolRefusesToDialWhileItHoldsNoPin(t *testing.T) {
	// The dial is never supposed to be reached, so it reports that it was rather
	// than opening anything: a pool that got this far is already wrong.
	dialled := false
	dial := func(context.Context, string, string) (net.Conn, error) {
		dialled = true
		return nil, errors.New("the admitted pool dialled without a pin")
	}

	// An unpinned connection in the *admitted* pool is a contradiction in
	// terms, so it does not even open one. The refusal is what closes the
	// window structurally, whatever a later change does to the ordering in
	// attest.
	admitted := newAdmittedPool("router.example.test", 443, dial)
	conn, err := admitted.dialTLS(context.Background(), "tcp", admitted.addr)
	if conn != nil {
		t.Error("the admitted pool handed back a connection it holds no pin for")
	}
	var unpinned *unpinnedPoolError
	if !errors.As(err, &unpinned) {
		t.Fatalf("err = %v, want an unpinned-pool refusal", err)
	}
	if dialled {
		t.Error("the admitted pool opened a connection before refusing it")
	}

	// The open pool is the one an empty pin is meant for: `failMode: open` has
	// no verdict to bind to, which is the whole of what it opts into.
	open := newPool("router.example.test", 443, dial)
	if open.requirePin {
		t.Error("the open pool requires a pin, so failMode: open could never dial")
	}
}

// TestAnAdmittedVerdictWithNoLeafIsRefusedRatherThanForwarded covers the one way
// the contradiction is reachable without a race: a verifier that admits but
// records no observed fingerprint leaves the pool with nothing to pin. Before
// SUP-428 such a verdict forwarded traffic over whatever certificate the peer
// presented while reporting `allow`.
func TestAnAdmittedVerdictWithNoLeafIsRefusedRatherThanForwarded(t *testing.T) {
	ep, scripted, listen := deniedEndpoint(t)
	scripted.allow("") // admitted, and bound to nothing

	if result := ep.attest(context.Background(), 0); result == nil || !result.Admitted {
		t.Fatalf("verdict = %v, want the admitted one the verifier returned", result)
	}
	if pin := ep.admittedPin(); pin != "" {
		t.Fatalf("pin = %q, want the empty pin an admitted verdict with no leaf leaves", pin)
	}

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+listen+"/v1/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("GET /v1/models: %v", err)
	}
	defer resp.Body.Close() //nolint:errcheck // test cleanup

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusServiceUnavailable)
	}
	if got := resp.Header.Get(VerdictHeader); got == "" || got == "allow" {
		t.Errorf("%s = %q, want a denial", VerdictHeader, got)
	}
}

// observableConn is the socket under a TLS connection, watching for the one
// write that distinguishes a revocation from a graceful shutdown: the
// close_notify alert.
type observableConn struct {
	net.Conn
	revoked        atomic.Bool
	alertDelivered atomic.Bool
}

func (c *observableConn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	if err == nil && c.revoked.Load() {
		c.alertDelivered.Store(true)
	}
	return n, err
}

// A revoked connection is swept with endpoint.mu held, so the sweep must not
// wait on anything. tls.Conn.Close gives itself five seconds to deliver
// close_notify, which a peer that has stopped reading would make it spend —
// with every reader of the verdict queued behind it. Dropping the socket before
// closing the TLS connection over it is what prevents that, and a close_notify
// that never reaches the wire is how the test sees it happen.
func TestARevokedConnectionIsDroppedWithoutWaitingOnTLSShutdown(t *testing.T) {
	addr, fingerprint := testTLSServer(t)

	var socket *observableConn
	p := newAdmittedPool("router.example.test", 443, func(ctx context.Context, network, _ string) (net.Conn, error) {
		inner, err := (&net.Dialer{}).DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		socket = &observableConn{Conn: inner}
		return socket, nil
	})
	p.setPin(fingerprint)

	conn, err := p.dialTLS(context.Background(), "tcp", p.addr)
	if err != nil {
		t.Fatalf("dialling under the pin the server presents: %v", err)
	}
	defer conn.Close() //nolint:errcheck // test cleanup
	if socket == nil {
		t.Fatal("the dial never ran")
	}

	// Everything from here on is the sweep. The handshake's own writes are
	// behind us, so a write that lands now is the shutdown alert.
	socket.revoked.Store(true)
	p.setPin(attestation.SHA256Fingerprint([]byte("a rotated leaf")))

	if socket.alertDelivered.Load() {
		t.Error("the sweep wrote close_notify to a connection it was revoking, " +
			"so Close can block for five seconds on a peer that has stopped reading")
	}
}
