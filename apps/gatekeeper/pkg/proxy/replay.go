package proxy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptrace"
	"sync"
)

// replayBufferLimit is how much of a request body is kept for a replay.
//
// A replay is only ever attempted for a request that moved no bytes on the
// wire, and the transport stages at most one write buffer (4 KiB) plus one
// io.Copy chunk (32 KiB) before its first write reaches the connection — so
// that is all a replayable request can have consumed. The limit is the bound on
// memory per request, not a guess at body sizes: a body read past it simply
// stops being replayable, which is the conservative answer.
const replayBufferLimit = 64 << 10

// errAttemptAbandoned is what a superseded attempt reads from the body if the
// transport is still draining it after RoundTrip has returned.
var errAttemptAbandoned = errors.New("request body belongs to a newer attempt")

// replayingTransport sends a request through its pool's transport, and sends it
// once more if — and only if — the first attempt provably never reached the
// upstream (SUP-289).
//
// "Provably" is decided from the connection, not from the error text. Either
// the request never got a connection at all (the dial or the TLS handshake
// failed: nothing was sent), or it got a reused keep-alive connection that then
// moved not a single byte in either direction before failing — the shape of a
// connection the remote closed while it sat idle in the pool. net/http will not
// replay a POST in either case: it cannot rewind a proxied body, and it does
// not know the request is safe to send twice. Here both are known.
//
// Everything else is surfaced as it is today. In particular a request that put
// even one byte on the wire is never replayed: the upstream may have started a
// generation, and running it twice is worse than failing once. A certificate
// that is not the attested one is a denial, not a transport failure, and is
// not replayed either.
type replayingTransport struct {
	pool *pool
	// onReplay, when set, is told why a request is being sent a second time.
	onReplay func(error)
}

func (t *replayingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body := newReplayBody(req.Body)
	first, attempt := t.attempt(req, body)
	resp, err := t.pool.transport.RoundTrip(first)
	if err == nil || !attempt.replayable(req.Context(), err) || !body.rewindable() {
		return resp, err
	}

	// The connection that failed is gone, but any other idle one in the pool
	// has been sitting there just as long; the replay goes out on a fresh dial.
	t.pool.transport.CloseIdleConnections()
	if t.onReplay != nil {
		t.onReplay(err)
	}
	second, _ := t.attempt(req, body)
	return t.pool.transport.RoundTrip(second)
}

// attempt prepares one send of req: its own view of the body, and a trace that
// records which connection carried it and how much that connection had moved.
func (t *replayingTransport) attempt(req *http.Request, body *replayBody) (*http.Request, *attemptTrace) {
	trace := &attemptTrace{}
	ctx := httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{GotConn: trace.gotConn})
	out := req.Clone(ctx)
	if body != nil {
		out.Body = body.view()
	}
	return out, trace
}

// attemptTrace is what one attempt learned about the connection it was given.
type attemptTrace struct {
	mu     sync.Mutex
	got    bool
	reused bool
	conn   *trackedConn
	before int64
}

func (a *attemptTrace) gotConn(info httptrace.GotConnInfo) {
	a.mu.Lock()
	defer a.mu.Unlock()
	// Overwritten if the transport itself retries on another connection: what
	// matters is the connection the attempt finally failed on.
	a.got, a.reused = true, info.Reused
	a.conn, _ = info.Conn.(*trackedConn)
	if a.conn != nil {
		a.before = a.conn.traffic()
	}
}

// replayable reports whether err ended an attempt that never reached the
// upstream.
func (a *attemptTrace) replayable(ctx context.Context, err error) bool {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return false
	}
	var mismatch *leafMismatchError
	if errors.As(err, &mismatch) {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.got {
		// No connection was ever handed over: the dial or the handshake
		// failed, and the request was not written anywhere.
		return true
	}
	// A fresh connection that failed is not the stale-keep-alive case, and an
	// untracked one cannot be judged: neither is replayed.
	return a.reused && a.conn != nil && a.conn.traffic() == a.before
}

// replayBody records the start of a request body so that an attempt that never
// reached the upstream can be sent again with the same bytes.
//
// Each attempt reads through its own view. Views never close the underlying
// body — the server that received the request owns it — and a view that has
// been superseded by a newer attempt refuses to read, so a transport still
// draining a failed attempt cannot steal bytes from the replay.
type replayBody struct {
	mu       sync.Mutex
	src      io.Reader
	recorded []byte
	// overflowed is set once more was read than replayBufferLimit allows to
	// keep; from then on the body cannot be rewound.
	overflowed bool
	current    *replayView
}

// newReplayBody wraps body, or returns nil for a request without one.
func newReplayBody(body io.ReadCloser) *replayBody {
	if body == nil || body == http.NoBody {
		return nil
	}
	return &replayBody{src: body}
}

// rewindable reports whether a new view would replay the body from its first
// byte. A nil body always is.
func (b *replayBody) rewindable() bool {
	if b == nil {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return !b.overflowed
}

// view starts a new attempt's read of the body from the beginning, and retires
// the previous one.
func (b *replayBody) view() io.ReadCloser {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.current = &replayView{body: b}
	return b.current
}

func (b *replayBody) read(v *replayView, p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if v != b.current {
		return 0, errAttemptAbandoned
	}
	if v.pos < len(b.recorded) {
		n := copy(p, b.recorded[v.pos:])
		v.pos += n
		return n, nil
	}
	n, err := b.src.Read(p)
	if n > 0 && !b.overflowed {
		if len(b.recorded)+n > replayBufferLimit {
			b.overflowed, b.recorded = true, nil
		} else {
			b.recorded = append(b.recorded, p[:n]...)
			v.pos += n
		}
	}
	return n, err
}

type replayView struct {
	body *replayBody
	pos  int
}

func (v *replayView) Read(p []byte) (int, error) { return v.body.read(v, p) }

// Close does not close the underlying body: a replay may still need it, and the
// server closes it once the handler returns.
func (v *replayView) Close() error { return nil }
