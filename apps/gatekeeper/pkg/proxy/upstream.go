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
	return fmt.Sprintf("the upstream presented %s, not the certificate this endpoint was attested over (%s)",
		e.Got, e.Want)
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
	p.mu.Lock()
	changed := p.pin != pin
	p.pin = pin
	p.mu.Unlock()
	if changed {
		p.closeAll()
	}
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
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, err
	}

	state := conn.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		_ = conn.Close()
		return nil, errors.New("the upstream presented no certificate")
	}
	if pin != "" {
		observed := attestation.SHA256Fingerprint(state.PeerCertificates[0].Raw)
		if !attestation.FingerprintsEqual(pin, observed) {
			_ = conn.Close()
			return nil, &leafMismatchError{Want: pin, Got: observed}
		}
	}

	tracked := &trackedConn{Conn: conn, pool: p}
	p.mu.Lock()
	// A pin that changed during the handshake invalidates this connection
	// before it ever carries a request.
	if p.pin != pin {
		p.mu.Unlock()
		_ = conn.Close()
		return nil, &leafMismatchError{Want: p.pin, Got: pin}
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
