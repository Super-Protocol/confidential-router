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
	idleConnTimeout       = 90 * time.Second
	maxIdleConnsPerHost   = 32
	defaultHTTPSPort      = 443
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

	mu        sync.Mutex
	pin       string
	conns     map[net.Conn]struct{}
	transport *http.Transport
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
	for _, conn := range stale {
		_ = conn.Close()
	}
	p.transport.CloseIdleConnections()
}

// closeAll drops every connection the pool holds. It is what a verdict flip
// from allow to deny under `failMode: closed` does to traffic already in flight
// (ADR-003 §7).
func (p *pool) closeAll() {
	// The connections are taken out of the map before any of them is closed:
	// closing one calls back into [pool.forget], which takes the same lock.
	for _, conn := range p.take() {
		_ = conn.Close()
	}
	p.transport.CloseIdleConnections()
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

	tracked := &trackedConn{Conn: conn, pool: p}
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
type trackedConn struct {
	net.Conn
	pool *pool
	once sync.Once
}

func (c *trackedConn) Close() error {
	c.once.Do(func() { c.pool.forget(c) })
	return c.Conn.Close()
}
