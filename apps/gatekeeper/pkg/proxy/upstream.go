package proxy

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
)

// Transport defaults. They are the connection-level half of "long-lived
// requests pass through": nothing here may impose a deadline on a response
// body, because a streamed completion legitimately takes minutes.
const (
	dialTimeout         = 15 * time.Second
	tlsHandshakeTimeout = 15 * time.Second
	// Generous on purpose: a queued completion can take minutes to produce its
	// first token, and this deadline covers the response *headers*. It exists
	// only so that an upstream that accepted a connection and then went silent
	// is eventually given up on.
	responseHeaderTimeout = 5 * time.Minute
	// idleConnTimeout must stay below the keep-alive timeout of every upstream
	// gateway the sidecar talks to, so that the local pool drops an idle
	// connection before the remote end does. nginx and OpenResty close one after
	// `keepalive_timeout` — 65 s by default, 60–75 s across the family — and the
	// Swarm gateway in front of external endpoints measured 64 s. A connection
	// the remote has abandoned but the pool still holds is the one the next POST
	// rides and dies on (SUP-289). 30 s leaves a margin for a gateway configured
	// tighter than the default; the cost is a fresh handshake after half a
	// minute of silence, which is nothing next to a completion.
	idleConnTimeout     = 30 * time.Second
	maxIdleConnsPerHost = 32
	defaultHTTPSPort    = 443
)

// leafMismatchError is returned by a dial whose peer presented a certificate
// other than the one the endpoint's verdict was formed over.
//
// It is a denial, not a transport failure: the verdict says "this deployment,
// on this channel", and a different leaf means the channel is not the attested
// one — whether because the deployment rotated its certificate or because
// something is terminating TLS in between.
type leafMismatchError struct {
	Want string
	Got  string
}

func (e *leafMismatchError) Error() string {
	// Hex, like every other fingerprint a user reads: this message reaches them
	// through the 503 body, the log and the audit log.
	return fmt.Sprintf("the upstream presented %s, not the certificate this endpoint was attested over (%s)",
		attestation.FormatDigestHex(e.Got), attestation.FormatDigestHex(e.Want))
}

// unpinnedPoolError is returned by a dial on a pool that may only carry
// attested traffic while it is holding no pin.
//
// An unpinned connection in the *admitted* pool is a contradiction in terms: a
// request reaches that pool only because a verdict admitted it, and a verdict
// that admits carries the leaf it was formed over. So this error says a verdict
// and the data plane disagree, which is a trust-chain failure and not a
// transport one — and refusing beats forwarding a request the audit log would
// then record as `allow` over a channel nothing was ever held to (SUP-428).
type unpinnedPoolError struct{}

func (*unpinnedPoolError) Error() string {
	return "this endpoint holds no attested certificate to pin the connection to"
}

// pool is one http.Transport whose TLS handshakes are all held to the same
// expected leaf certificate.
//
// A pool exists per pin rather than per endpoint because connections are
// reused: a connection dialled while the endpoint was unverified must never
// carry a request admitted under a verdict, and vice versa. Changing the pin
// closes every connection the pool holds, idle or in flight.
type pool struct {
	hostname string
	// addr is what the transport dials; host is what the request's Host header
	// and the URL authority carry. They differ on the default port, which a
	// client would not spell out and neither does the gatekeeper.
	addr string
	host string
	dial DialFunc
	// requirePin makes an empty pin a refusal rather than a wildcard. See
	// [newAdmittedPool]. Set at construction and never written again, which is
	// why dialTLS reads it without the lock.
	requirePin bool

	mu        sync.Mutex
	pin       string
	conns     map[net.Conn]struct{}
	transport *http.Transport
	// roundTripper is what the reverse proxy sends through: transport, plus
	// the one replay a request that provably never left is allowed.
	roundTripper *replayingTransport
}

// newPool builds a pool for one upstream host. An empty pin accepts whatever
// certificate the peer presents — the unverified mode `failMode: open` opts
// into, where there is no verdict to bind to in the first place.
func newPool(hostname string, port int, dial DialFunc) *pool {
	p := &pool{
		hostname: hostname,
		addr:     net.JoinHostPort(hostname, strconv.Itoa(port)),
		host:     hostname,
		dial:     dial,
		conns:    map[net.Conn]struct{}{},
	}
	if port != defaultHTTPSPort {
		p.host = p.addr
	}
	p.transport = &http.Transport{
		DialTLSContext:        p.dialTLS,
		TLSHandshakeTimeout:   tlsHandshakeTimeout,
		ResponseHeaderTimeout: responseHeaderTimeout,
		IdleConnTimeout:       idleConnTimeout,
		MaxIdleConnsPerHost:   maxIdleConnsPerHost,
		ForceAttemptHTTP2:     false,
	}
	p.roundTripper = &replayingTransport{pool: p}
	return p
}

// newAdmittedPool builds the pool that carries nothing but attested traffic, so
// an empty pin is a contradiction there rather than the wildcard [newPool]
// documents: it refuses to dial at all until it holds a leaf.
//
// It closes the window the ordering in [endpoint.attest] closes, a second time
// and structurally — whatever a future reordering does to that sequence, a
// request can no longer be forwarded as admitted over a connection the pool was
// not holding to the attested leaf (SUP-428).
func newAdmittedPool(hostname string, port int, dial DialFunc) *pool {
	p := newPool(hostname, port, dial)
	p.requirePin = true
	return p
}

// setPin points the pool at a new expected leaf. Connections opened under the
// old one are closed immediately, in flight or not: they are no longer covered
// by a verdict.
func (p *pool) setPin(pin string) {
	// The flip and the sweep happen under one lock hold, so that a connection
	// admitted against the *new* pin — a handshake that finished after the flip
	// — cannot be swept by the flip that preceded it. The closing itself is
	// done outside the lock: Close calls back into [pool.forget].
	p.mu.Lock()
	changed := p.pin != pin
	p.pin = pin
	var stale []net.Conn
	if changed {
		stale = p.takeLocked()
	}
	p.mu.Unlock()
	if !changed {
		return
	}
	discardAll(stale)
	p.transport.CloseIdleConnections()
}

// closeAll drops every connection the pool holds. It is what a verdict flip
// from allow to deny under `failMode: closed` does to traffic already in flight
// (ADR-003 §7).
func (p *pool) closeAll() {
	// The connections are taken out of the map before any of them is closed:
	// closing one calls back into [pool.forget], which takes the same lock.
	discardAll(p.take())
	p.transport.CloseIdleConnections()
}

// discardAll drops connections the pool has revoked, without waiting for the
// TLS shutdown each one would otherwise get.
//
// A connection a verdict no longer covers is not owed `close_notify`: it is
// being refused, not finished with. That is also what keeps the sweep quick,
// which matters because both callers can run with endpoint.mu held — see
// [endpoint.movePool] and [endpoint.release]. `tls.Conn.Close` sets its own
// five-second write deadline to deliver that alert, so a peer that has stopped
// reading would otherwise stall every reader of the verdict for five seconds
// per socket. Closing the connection underneath makes the alert's write fail at
// once.
func discardAll(conns []net.Conn) {
	for _, conn := range conns {
		if tracked, ok := conn.(*trackedConn); ok && tracked.raw != nil {
			_ = tracked.raw.Close()
		}
		_ = conn.Close()
	}
}

func (p *pool) take() []net.Conn {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.takeLocked()
}

// takeLocked is take for a caller that already holds the lock.
func (p *pool) takeLocked() []net.Conn {
	out := make([]net.Conn, 0, len(p.conns))
	for conn := range p.conns {
		out = append(out, conn)
	}
	clear(p.conns)
	return out
}

// dialTLS opens one connection to the upstream and refuses it unless the leaf
// certificate is the pinned one.
//
// The handshake deliberately does not consult the system pool: trust is decided
// by the evidence chain terminating at a user-configured root plus this
// fingerprint comparison (ADR-003 §1), and Swarm Cloud roots are not publicly
// trusted. HTTP/1.1 is the only protocol offered, because an h2 connection is
// multiplexed across requests and would outlive the verdict that admitted the
// first of them — and because a WebSocket upgrade needs h1 anyway.
func (p *pool) dialTLS(ctx context.Context, network, addr string) (net.Conn, error) {
	p.mu.Lock()
	pin := p.pin
	p.mu.Unlock()
	if p.requirePin && pin == "" {
		return nil, &unpinnedPoolError{}
	}

	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	raw, err := attestation.DialTCP(dialCtx, p.dial, network, addr)
	if err != nil {
		return nil, err
	}

	conn := tls.Client(raw, &tls.Config{
		ServerName: p.hostname,
		//nolint:gosec // G402: see the comment above — the chain is judged by the
		// attestation pipeline, and the leaf by the pin below.
		InsecureSkipVerify: true,
		NextProtos:         []string{"http/1.1"},
	})
	// dialCtx, not ctx: Transport.TLSHandshakeTimeout does not apply when
	// DialTLSContext is set, so without this an upstream that accepts a
	// connection and then says nothing stalls for the client's whole patience.
	if err := conn.HandshakeContext(dialCtx); err != nil {
		_ = raw.Close()
		return nil, err
	}

	state := conn.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		_ = conn.Close()
		return nil, errors.New("the upstream presented no certificate")
	}
	// Unconditionally, because the recheck below reports it too and can be
	// reached from an empty starting pin.
	observed := attestation.SHA256Fingerprint(state.PeerCertificates[0].Raw)
	if pin != "" && !attestation.FingerprintsEqual(pin, observed) {
		_ = conn.Close()
		return nil, &leafMismatchError{Want: pin, Got: observed}
	}

	tracked := &trackedConn{Conn: conn, raw: raw, pool: p}
	p.mu.Lock()
	// What decides this connection is the pin in force now, not the one read
	// before the handshake. A pin that changed mid-handshake and no longer
	// matches the leaf invalidates the connection before it ever carries a
	// request; a pin that changed *to* this leaf — the first verdict landing
	// while the first request is already dialling — attests exactly this
	// channel, so the connection is kept and tracked under it. The current pin
	// is read into a local under the lock: reading the field again after
	// unlocking would race with the setPin this branch exists to catch.
	if current := p.pin; current != pin && !attestation.FingerprintsEqual(current, observed) {
		p.mu.Unlock()
		_ = conn.Close()
		if current == "" {
			// The verdict flipped to a denial while this handshake was in
			// flight, so there is no leaf to name in a mismatch.
			return nil, &unpinnedPoolError{}
		}
		return nil, &leafMismatchError{Want: current, Got: observed}
	}
	p.conns[tracked] = struct{}{}
	p.mu.Unlock()
	return tracked, nil
}

func (p *pool) forget(conn net.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.conns, conn)
}

// trackedConn is an upstream connection the pool can reach to close.
//
// It also counts the bytes that cross it, which is how a failed request is
// judged replayable: a request whose connection moved no bytes between being
// handed the connection and failing never reached the upstream.
type trackedConn struct {
	net.Conn
	// raw is the TCP connection underneath the TLS one, kept so that a
	// revocation can drop the socket without waiting on a TLS alert. See
	// [discardAll].
	raw     net.Conn
	pool    *pool
	once    sync.Once
	written atomic.Int64
	read    atomic.Int64
}

func (c *trackedConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	c.read.Add(int64(n))
	return n, err
}

func (c *trackedConn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	c.written.Add(int64(n))
	return n, err
}

// traffic is the number of bytes moved in either direction so far.
func (c *trackedConn) traffic() int64 { return c.written.Load() + c.read.Load() }

func (c *trackedConn) Close() error {
	c.once.Do(func() { c.pool.forget(c) })
	return c.Conn.Close()
}
