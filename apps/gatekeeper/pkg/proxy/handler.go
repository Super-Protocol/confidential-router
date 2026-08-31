package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// VerdictHeader carries the gatekeeper's decision back to the local client. It
// is written on the client-facing response only: nothing about the verdict is
// ever sent upstream (ADR-003 §6), which is what makes "the router does not
// know when, whether or by whom it is attested" true at the wire level.
const VerdictHeader = "X-Gatekeeper-Verdict"

// headerPrefix is stripped from every proxied request for the same reason: a
// client must not be able to forge a verdict header into the router's view, and
// the gatekeeper must not leak its own.
const headerPrefix = "X-Gatekeeper-"

// requestState travels with one request so that ModifyResponse and the error
// handler can see what admission decided and when the request started.
type requestState struct {
	start   time.Time
	verdict string
	// ttfb is the time to the upstream's response headers, filled in by
	// ModifyResponse.
	ttfb time.Duration
	// upstreamErr records a transport failure, so the outcome is recorded as
	// one rather than as a served request.
	upstreamErr error
}

type stateKey struct{}

func stateOf(ctx context.Context) *requestState {
	state, _ := ctx.Value(stateKey{}).(*requestState)
	return state
}

// ServeHTTP is the whole data path: admit, then forward.
func (e *endpoint) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := e.sup.now()
	e.stats.request()

	current := e.await(r.Context())
	switch {
	case current != nil && current.Admitted:
		e.forward(w, r, start, e.admittedRP, "allow", outcomeAllowed)
	case e.tuning.FailMode == config.FailOpen:
		stage, reason := current.denial()
		e.sup.log("warn", e.name,
			"forwarding WITHOUT a valid verdict (failMode: open) — "+stage+": "+reason)
		e.sup.audit.record(AuditEntry{
			At: start, Event: AuditUnverified, Endpoint: e.name, Admitted: false,
			Stage: stage, Reason: reason, Method: r.Method, Path: r.URL.Path,
			FailMode: config.FailOpen,
		})
		e.forward(w, r, start, e.openRP, "deny "+stage+": "+reason, outcomeUnverified)
	default:
		e.refuse(w, r, start, current)
	}
}

// refuse answers a request the endpoint holds no verdict for. `failMode:
// closed` is the default, and it never opens an upstream connection.
func (e *endpoint) refuse(w http.ResponseWriter, r *http.Request, start time.Time, current *verdict) {
	stage, reason := current.denial()
	e.sup.metrics.requests.WithLabelValues(e.name, outcomeBlocked).Inc()
	e.sup.metrics.duration.WithLabelValues(e.name).Observe(e.sup.now().Sub(start).Seconds())
	e.sup.audit.record(AuditEntry{
		At: start, Event: AuditBlocked, Endpoint: e.name, Admitted: false,
		Stage: stage, Reason: reason, Method: r.Method, Path: r.URL.Path,
		Status: http.StatusServiceUnavailable, FailMode: config.FailClosed,
	})
	writeDenial(w, stage, reason)
}

// denialBody is the 503 an unverified endpoint answers with.
//
// The `error` member is the OpenAI-compatible shape ADR-003 §6 specifies, so a
// client library surfaces the message instead of a bare status; `stage` and
// `reason` repeat it as machine-readable fields, because "which check failed"
// is what a script branches on.
type denialBody struct {
	Error struct {
		Type    string `json:"type"`
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Stage  string `json:"stage"`
	Reason string `json:"reason"`
}

func writeDenial(w http.ResponseWriter, stage, reason string) {
	body := denialBody{Stage: stage, Reason: reason}
	body.Error.Type = "gatekeeper_error"
	body.Error.Code = "attestation_failed"
	body.Error.Message = stage + ": " + reason

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(VerdictHeader, "deny "+stage+": "+reason)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(body)
}

// forward hands one request to the reverse proxy over the given pool, counting
// what crosses in both directions.
func (e *endpoint) forward(w http.ResponseWriter, r *http.Request, start time.Time,
	rp *httputil.ReverseProxy, verdictHeader, outcome string,
) {
	state := &requestState{start: start, verdict: verdictHeader}
	r = r.WithContext(context.WithValue(r.Context(), stateKey{}, state))

	if r.Body != nil {
		r.Body = &countingReader{r: r.Body, flow: e.flow}
	}
	rp.ServeHTTP(&countingWriter{ResponseWriter: w, flow: e.flow}, r)

	e.sup.metrics.duration.WithLabelValues(e.name).Observe(e.sup.now().Sub(start).Seconds())
	if state.ttfb > 0 {
		e.sup.metrics.ttfb.WithLabelValues(e.name).Observe(state.ttfb.Seconds())
	}
	if outcome != "" {
		if state.upstreamErr != nil {
			outcome = outcomeUpstreamError
		}
		e.sup.metrics.requests.WithLabelValues(e.name, outcome).Inc()
	}
}

// newReverseProxy builds the forwarding half of the data plane over one
// connection pool.
func (e *endpoint) newReverseProxy(p *pool) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Transport: p.transport,
		// -1 flushes after every write to the client. It is what makes
		// `text/event-stream` arrive chunk by chunk instead of in one buffered
		// block at the end of a completion.
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = "https"
			pr.Out.URL.Host = p.host
			// The request — and the SNI of the connection carrying it — name the
			// upstream, not the loopback address the client dialled. The default
			// port is left out, exactly as a client talking to the router
			// directly would leave it out.
			pr.Out.Host = p.host
			// Hop-by-hop headers are already gone; these are ours, and a client
			// must not be able to forge them into the router's view.
			for name := range pr.Out.Header {
				if strings.HasPrefix(http.CanonicalHeaderKey(name), headerPrefix) {
					pr.Out.Header.Del(name)
				}
			}
			// X-Forwarded-* is deliberately not set. The upstream has no use for
			// the loopback address a local client dialled, and the gatekeeper's
			// job is to tell the router less about its user, not more.
		},
		ModifyResponse: func(resp *http.Response) error {
			if state := stateOf(resp.Request.Context()); state != nil {
				state.ttfb = e.sup.now().Sub(state.start)
				if state.verdict != "" {
					resp.Header.Set(VerdictHeader, state.verdict)
				}
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			e.upstreamFailed(w, r, err)
		},
	}
}

// upstreamFailed turns a transport error into an answer for the client.
//
// A certificate that is not the attested one is the case worth separating: it
// is not a broken upstream, it is the channel binding failing at request time,
// so it answers as a denial and schedules a re-verification. That is the path a
// certificate rotation — or a TLS-terminating interceptor — takes between two
// background re-attestations.
func (e *endpoint) upstreamFailed(w http.ResponseWriter, r *http.Request, err error) {
	verdict := "allow"
	if state := stateOf(r.Context()); state != nil {
		state.upstreamErr = err
		verdict = state.verdict
	}

	var mismatch *leafMismatchError
	if errors.As(err, &mismatch) {
		e.sup.log("error", e.name, "upstream certificate changed — "+mismatch.Error())
		e.sup.audit.record(AuditEntry{
			At: e.sup.now(), Event: AuditBlocked, Endpoint: e.name, Admitted: false,
			Stage: "tls-fingerprint", Reason: mismatch.Error(),
			Method: r.Method, Path: r.URL.Path, Status: http.StatusServiceUnavailable,
			FailMode: e.tuning.FailMode,
		})
		// Not on the request's context: it is about to be cancelled, and the
		// re-check is for the endpoint, not for this client.
		go e.attest(context.WithoutCancel(r.Context()), false)
		writeDenial(w, "tls-fingerprint", mismatch.Error())
		return
	}

	if errors.Is(err, context.Canceled) {
		// The client hung up. Nothing to report and nowhere to report it.
		return
	}
	e.sup.log("error", e.name, "upstream request failed: "+err.Error())
	w.Header().Set("Content-Type", "application/json")
	// The verdict this request was admitted under, not a fresh one: a
	// `failMode: open` request whose upstream broke was still unverified.
	w.Header().Set(VerdictHeader, verdict)
	w.WriteHeader(http.StatusBadGateway)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{
		"type": "gatekeeper_error", "code": "upstream_unavailable", "message": err.Error(),
	}})
}
