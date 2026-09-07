package proxy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// verdict is one completed verification, reduced to what admission needs.
type verdict struct {
	// Report is the full result, as `gatekeeper status --endpoint` prints it.
	Report *status.Report
	At     time.Time
	// Admitted is the only field that decides whether traffic flows.
	Admitted bool
	Stage    string
	Reason   string
	// Leaf is the TLS certificate the verification observed. Every proxied
	// connection is held to it.
	Leaf string
}

// denial renders the verdict as the `stage: reason` pair the 503 body and the
// verdict header carry.
func (v *verdict) denial() (stage, reason string) {
	if v == nil {
		return stageAttesting, "no verification has completed for this endpoint yet"
	}
	stage = v.Stage
	if stage == "" {
		stage = "policy"
	}
	reason = v.Reason
	if reason == "" {
		reason = v.Report.Denied()
	}
	return stage, reason
}

// stageAttesting is the stage reported when the endpoint has no verdict at all
// yet. It is not one of the pipeline's own stages (ADR-003 §1) because no stage
// has run.
const stageAttesting = "attesting"

// endpoint is one configured endpoint at runtime: its listener, its verdict,
// and the two connection pools its traffic can take.
type endpoint struct {
	sup *Supervisor

	name     string
	listen   string
	upstream string
	hostname string
	port     int
	tuning   config.Tuning

	// admittedPool carries traffic covered by a verdict and is pinned to the
	// leaf that verdict observed. openPool carries `failMode: open` traffic
	// that no verdict covers, and is pinned to nothing — there is nothing to
	// pin it to. They never share a connection.
	admittedPool *pool
	openPool     *pool
	admittedRP   *httputil.ReverseProxy
	openRP       *httputil.ReverseProxy

	stats counters
	// flow accounts for bytes as they cross, in both directions.
	flow *flow

	mu      sync.Mutex
	running bool
	// generation counts the times this endpoint has been started. A
	// verification that completes after its listener was stopped belongs to the
	// previous generation and is discarded rather than installed.
	generation int
	bindErr    string
	listener   net.Listener
	server     *http.Server
	cancel     context.CancelFunc
	loopDone   chan struct{}

	verdict *verdict
	// firstVerdict is closed once the first verification has finished, whatever
	// it decided. The very first request waits on it (ADR-003 §7).
	firstVerdict chan struct{}
	lastAttestAt time.Time
	nextAttestAt time.Time

	// attesting and attestDone are the single-flight guard: concurrent callers
	// join the verification already running instead of starting another.
	attesting  bool
	attestDone chan struct{}
}

func newEndpoint(sup *Supervisor, spec config.Endpoint, tuning config.Tuning) (*endpoint, error) {
	hostname, port, err := splitUpstream(spec.Upstream)
	if err != nil {
		return nil, fmt.Errorf("endpoint %q: %w", spec.Name, err)
	}
	ep := &endpoint{
		sup:          sup,
		name:         spec.Name,
		listen:       spec.Listen,
		upstream:     spec.Upstream,
		hostname:     hostname,
		port:         port,
		tuning:       tuning,
		admittedPool: newPool(hostname, port, sup.opts.Dial),
		openPool:     newPool(hostname, port, sup.opts.Dial),
		firstVerdict: make(chan struct{}),
	}
	ep.flow = &flow{
		stats: &ep.stats,
		in:    sup.metrics.bytes.WithLabelValues(spec.Name, "in"),
		out:   sup.metrics.bytes.WithLabelValues(spec.Name, "out"),
	}
	sup.metrics.initialise(spec.Name)
	ep.admittedRP = ep.newReverseProxy(ep.admittedPool)
	ep.openRP = ep.newReverseProxy(ep.openPool)
	return ep, nil
}

// splitUpstream reduces an `https://host[:port]` upstream to the host the
// evidence is published for and the port to reach it on.
func splitUpstream(raw string) (hostname string, port int, err error) {
	parsed, err := url.Parse(strings.TrimSuffix(raw, "/"))
	if err != nil {
		return "", 0, fmt.Errorf("upstream %q: %w", raw, err)
	}
	if parsed.Scheme != "https" || parsed.Hostname() == "" {
		return "", 0, fmt.Errorf("upstream %q must be an https:// URL", raw)
	}
	port = 443
	if p := parsed.Port(); p != "" {
		if port, err = net.LookupPort("tcp", p); err != nil {
			return "", 0, fmt.Errorf("upstream %q: %w", raw, err)
		}
	}
	return parsed.Hostname(), port, nil
}

// sameSpec reports whether a reloaded endpoint is the one already running, so
// that a SIGHUP that touched an unrelated part of the file does not rebind a
// listener and drop live connections.
func (e *endpoint) sameSpec(spec config.Endpoint, tuning config.Tuning) bool {
	return e.listen == spec.Listen && e.upstream == spec.Upstream && e.tuning == tuning
}

// start binds the listener and begins attesting. It is a no-op when the
// endpoint is already running.
func (e *endpoint) start(ctx context.Context) error {
	e.mu.Lock()
	if e.running {
		e.mu.Unlock()
		return nil
	}

	listener, err := net.Listen("tcp", e.listen)
	if err != nil {
		e.bindErr = err.Error()
		e.mu.Unlock()
		e.sup.metrics.listening.WithLabelValues(e.name).Set(0)
		e.sup.log("error", e.name, "cannot bind "+e.listen+": "+err.Error())
		return fmt.Errorf("endpoint %q: %w", e.name, err)
	}

	loopCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	server := &http.Server{
		Handler: e,
		// No write or read deadline: a streamed completion is a legitimate
		// minutes-long response, and a WebSocket outlives any of them. Idle and
		// header timeouts still bound a client that connects and says nothing.
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return loopCtx },
	}

	e.running, e.bindErr = true, ""
	e.generation++
	e.listener, e.server, e.cancel = listener, server, cancel
	e.loopDone = make(chan struct{})
	e.stats.reset()
	loopDone := e.loopDone
	e.mu.Unlock()

	e.sup.metrics.listening.WithLabelValues(e.name).Set(1)
	e.sup.log("info", e.name, "listening on "+e.listen+" → "+e.upstream)

	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			e.sup.log("error", e.name, "listener stopped: "+err.Error())
		}
	}()
	go e.attestLoop(loopCtx, loopDone)
	return nil
}

// stop drains the listener and closes every upstream connection.
func (e *endpoint) stop(ctx context.Context) error {
	e.mu.Lock()
	if !e.running {
		e.mu.Unlock()
		return nil
	}
	server, cancel, loopDone := e.server, e.cancel, e.loopDone
	e.running = false
	e.generation++
	e.server, e.listener, e.cancel, e.loopDone = nil, nil, nil, nil
	// A stopped endpoint has no verdict: it is not being re-attested, so the
	// one it had would go stale unnoticed and the next start would admit
	// traffic on it before the first check completed.
	e.verdict = nil
	e.firstVerdict = make(chan struct{})
	e.lastAttestAt, e.nextAttestAt = time.Time{}, time.Time{}
	e.mu.Unlock()

	// Shutdown first, cancel second. The listener's BaseContext is loopCtx, so
	// cancelling before the drain would abort every request in flight — the
	// opposite of what a graceful stop is for.
	err := server.Shutdown(ctx)
	if err != nil {
		// The drain budget ran out with requests still in flight; closing is
		// what the caller asked for by bounding it.
		_ = server.Close()
	}
	cancel()
	<-loopDone

	e.admittedPool.closeAll()
	e.openPool.closeAll()
	e.sup.metrics.listening.WithLabelValues(e.name).Set(0)
	e.sup.metrics.admitted.WithLabelValues(e.name).Set(0)
	e.sup.log("info", e.name, "listener stopped")
	return err
}

// attestLoop re-runs the full pipeline every reattestInterval until the
// endpoint stops (ADR-003 §7). Requests are never blocked on it: they are
// admitted against the last verdict it produced.
func (e *endpoint) attestLoop(ctx context.Context, done chan struct{}) {
	defer close(done)

	e.attest(ctx, true)
	ticker := time.NewTicker(e.tuning.ReattestInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.attest(ctx, true)
		}
	}
}

// attest runs one verification and installs the verdict it produced.
//
// force skips the verdict cache. The background loop and an explicit
// "re-attest now" both force; the checks the data plane triggers on its own —
// the first request, a connection whose certificate did not match — do not, so
// a burst of them cannot turn into a burst of handshakes against the upstream.
func (e *endpoint) attest(ctx context.Context, force bool) *verdict {
	e.mu.Lock()
	if !force && e.verdict != nil && e.sup.now().Sub(e.verdict.At) < e.tuning.VerdictCacheTTL {
		current := e.verdict
		e.mu.Unlock()
		return current
	}
	if e.attesting {
		// Someone else is already asking the same question of the same host.
		waiting := e.attestDone
		e.mu.Unlock()
		select {
		case <-waiting:
		case <-ctx.Done():
		}
		return e.current()
	}
	e.attesting = true
	e.attestDone = make(chan struct{})
	done, generation := e.attestDone, e.generation
	e.mu.Unlock()

	result := e.verify(ctx)

	e.mu.Lock()
	if e.generation != generation {
		// The listener was stopped while this verification was in flight. Its
		// answer describes an endpoint that no longer exists.
		e.attesting = false
		e.mu.Unlock()
		close(done)
		return result
	}
	previous := e.verdict
	e.verdict = result
	e.lastAttestAt = result.At
	e.nextAttestAt = result.At.Add(e.tuning.ReattestInterval)
	e.attesting = false
	first := e.firstVerdict
	select {
	case <-first: // already closed
	default:
		close(first)
	}
	e.mu.Unlock()
	close(done)

	e.applyVerdict(previous, result)
	return result
}

// verify runs the verification seam and turns whatever came back into a
// verdict. A verifier that errors outright is a denial, not a crash: the
// endpoint stays up and says why it is refusing traffic.
func (e *endpoint) verify(ctx context.Context) *verdict {
	ctx, cancel := context.WithTimeout(ctx, e.tuning.InitialTimeout)
	defer cancel()

	report, err := e.sup.verify(ctx, status.VerifyRequest{
		Endpoint: e.name, Hostname: e.hostname, Port: e.port,
	})
	now := e.sup.now()
	if err != nil || report == nil {
		reason := "the verifier failed"
		if err != nil {
			reason = err.Error()
		}
		return &verdict{At: now, Stage: "fetch", Reason: reason,
			Report: &status.Report{Endpoint: e.name, Hostname: e.hostname, Port: e.port,
				CheckedAt: now, Stage: "fetch", Reason: reason}}
	}
	stage, reason := report.Stage, report.Reason
	if !report.Admitted && reason == "" {
		reason = report.Denied()
	}
	return &verdict{
		Report: report, At: now, Admitted: report.Admitted,
		Stage: stage, Reason: reason, Leaf: report.ObservedTLSFingerprint,
	}
}

// applyVerdict moves the data plane to a new verdict: it re-pins the connection
// pool, closes what the new verdict no longer covers, and reports the change.
func (e *endpoint) applyVerdict(previous, current *verdict) {
	if current.Admitted {
		// Pinning to the observed leaf is what makes the verdict a statement
		// about a channel rather than about a hostname. setPin closes every
		// connection opened under the previous leaf.
		e.admittedPool.setPin(current.Leaf)
	} else {
		e.admittedPool.setPin("")
		if e.tuning.FailMode == config.FailClosed {
			// ADR-003 §7: a flip to deny under fail-closed takes down the
			// connections already carrying traffic, not just the next request.
			e.admittedPool.closeAll()
		}
	}

	result := "admitted"
	if !current.Admitted {
		result = current.Stage
		if result == "" {
			result = "policy"
		}
	}
	e.sup.metrics.attestations.WithLabelValues(e.name, result).Inc()
	e.sup.metrics.admitted.WithLabelValues(e.name).Set(boolGauge(current.Admitted))

	if previous != nil && previous.Admitted == current.Admitted &&
		previous.Stage == current.Stage && previous.Reason == current.Reason {
		return // a re-attestation that confirmed what was already true
	}

	e.sup.metrics.transitions.WithLabelValues(e.name, verdictLabel(previous), verdictLabel(current)).Inc()
	stage, reason := current.denial()
	if current.Admitted {
		e.sup.log("info", e.name, "verdict allow: admitted")
	} else {
		level := "error"
		if e.tuning.FailMode == config.FailOpen {
			level = "warn"
		}
		e.sup.log(level, e.name, "verdict deny — "+stage+": "+reason)
	}
	e.sup.audit.record(AuditEntry{
		At: current.At, Event: AuditVerdict, Endpoint: e.name,
		Admitted: current.Admitted, Stage: nonAdmitted(current, stage), Reason: nonAdmitted(current, reason),
		EvidenceDigest:         attestation.FormatDigestHex(current.Report.EvidenceDigest),
		ObservedTLSFingerprint: attestation.FormatDigestHex(current.Leaf),
		Root:                   current.Report.Root,
		FailMode:               e.tuning.FailMode,
	})
	e.sup.publishSnapshot()
}

func nonAdmitted(v *verdict, value string) string {
	if v.Admitted {
		return ""
	}
	return value
}

func verdictLabel(v *verdict) string {
	switch {
	case v == nil:
		return "unknown"
	case v.Admitted:
		return "allow"
	default:
		return "deny"
	}
}

func boolGauge(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// current returns the verdict in force, or nil before the first one lands.
func (e *endpoint) current() *verdict {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.verdict
}

// await returns the verdict in force, waiting up to initialTimeout for the
// first one. Only the very first requests of an endpoint's life ever wait:
// after that there is always a verdict, and re-attestation replaces it in the
// background (ADR-003 §7).
func (e *endpoint) await(ctx context.Context) *verdict {
	e.mu.Lock()
	current, first, timeout := e.verdict, e.firstVerdict, e.tuning.InitialTimeout
	e.mu.Unlock()
	if current != nil {
		return current
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-first:
	case <-timer.C:
	case <-ctx.Done():
	}
	return e.current()
}

// snapshot renders the endpoint's live state for the dashboard and the admin
// API.
func (e *endpoint) snapshot() status.Endpoint {
	e.mu.Lock()
	running, bindErr := e.running, e.bindErr
	current := e.verdict
	out := status.Endpoint{
		Name: e.name, Listen: e.listen, Upstream: e.upstream, FailMode: e.tuning.FailMode,
		LastAttestAt: e.lastAttestAt, NextAttestAt: e.nextAttestAt,
	}
	e.mu.Unlock()

	out.RequestsPerSecond, out.BytesIn, out.BytesOut = e.stats.read()
	if current != nil {
		out.Report = current.Report
		out.PublishedDigest = current.Report.EvidenceDigest
	}

	switch {
	case bindErr != "":
		out.Health, out.Reason = status.Broken, "cannot bind "+e.listen+": "+bindErr
	case !running:
		out.Health, out.Reason = status.Stopped, "listener stopped"
		out.RequestsPerSecond, out.BytesIn, out.BytesOut = 0, 0, 0
	case current == nil:
		out.Health, out.Reason = status.Attesting, "waiting for the first verdict"
	case current.Admitted:
		out.Health = status.Confidential
	default:
		stage, reason := current.denial()
		out.Reason = stage + ": " + reason
		out.Health = status.Broken
		if e.tuning.FailMode == config.FailOpen {
			out.Health = status.NonConfidential
		}
	}
	return out
}
