package proxy

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Outcomes recorded per request. They are deliberately about the admission
// decision rather than the HTTP status: "the gatekeeper let 12 requests through
// unverified today" is the question this data exists to answer.
const (
	outcomeAllowed = "allowed"
	// outcomeUnverified is a `failMode: open` endpoint forwarding without a
	// valid verdict.
	outcomeUnverified = "unverified"
	// outcomeBlocked is a `failMode: closed` endpoint answering 503.
	outcomeBlocked = "blocked"
	// outcomeUpstreamError is an admitted request the upstream failed to serve.
	outcomeUpstreamError = "upstream-error"
)

// metrics is the Prometheus view of the data plane, exposed on the admin
// socket's /metrics and on `metrics.listen`.
type metrics struct {
	registry     *prometheus.Registry
	requests     *prometheus.CounterVec
	bytes        *prometheus.CounterVec
	duration     *prometheus.HistogramVec
	ttfb         *prometheus.HistogramVec
	transitions  *prometheus.CounterVec
	attestations *prometheus.CounterVec
	admitted     *prometheus.GaugeVec
	listening    *prometheus.GaugeVec
}

// latencyBuckets span a token-by-token completion as well as a health check:
// the p99 of an LLM request is minutes, and the default client buckets top out
// at ten seconds.
var latencyBuckets = []float64{0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300}

func newMetrics(registry *prometheus.Registry) *metrics {
	if registry == nil {
		registry = prometheus.NewRegistry()
	}
	m := &metrics{
		registry: registry,
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "gatekeeper_requests_total",
			Help: "Requests seen by an endpoint's listener, by admission outcome.",
		}, []string{"endpoint", "outcome"}),
		bytes: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "gatekeeper_bytes_total",
			Help: "Bytes proxied, by direction (in: client to upstream, out: upstream to client).",
		}, []string{"endpoint", "direction"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "gatekeeper_request_duration_seconds",
			Help:    "Wall time from accepting a request to finishing its response.",
			Buckets: latencyBuckets,
		}, []string{"endpoint"}),
		ttfb: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "gatekeeper_request_ttfb_seconds",
			Help:    "Time to the first byte of the upstream's response headers.",
			Buckets: latencyBuckets,
		}, []string{"endpoint"}),
		transitions: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "gatekeeper_verdict_transitions_total",
			Help: "Changes of an endpoint's verdict, by the states it moved between.",
		}, []string{"endpoint", "from", "to"}),
		attestations: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "gatekeeper_attestations_total",
			Help: "Completed verifications, by result (admit or the stage that denied).",
		}, []string{"endpoint", "result"}),
		admitted: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "gatekeeper_endpoint_admitted",
			Help: "1 when the endpoint holds a verdict that admits traffic, 0 otherwise.",
		}, []string{"endpoint"}),
		listening: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "gatekeeper_endpoint_listening",
			Help: "1 when the endpoint's local listener is bound, 0 otherwise.",
		}, []string{"endpoint"}),
	}
	registry.MustRegister(m.requests, m.bytes, m.duration, m.ttfb,
		m.transitions, m.attestations, m.admitted, m.listening)
	return m
}

// initialise creates an endpoint's series at zero.
//
// A counter that only appears once it is first incremented is a counter no
// alert can be written against: "no requests were blocked" and "the endpoint
// does not exist" would look identical to a scrape.
func (m *metrics) initialise(endpoint string) {
	for _, outcome := range []string{outcomeAllowed, outcomeUnverified, outcomeBlocked, outcomeUpstreamError} {
		m.requests.WithLabelValues(endpoint, outcome)
	}
	m.bytes.WithLabelValues(endpoint, "in")
	m.bytes.WithLabelValues(endpoint, "out")
	m.duration.WithLabelValues(endpoint)
	m.ttfb.WithLabelValues(endpoint)
	m.admitted.WithLabelValues(endpoint).Set(0)
	m.listening.WithLabelValues(endpoint).Set(0)
}

// forget drops an endpoint's series. A reload that removed an endpoint must not
// leave its counters behind, frozen at their last value and indistinguishable
// from an endpoint that has simply gone quiet.
func (m *metrics) forget(endpoint string) {
	labels := prometheus.Labels{"endpoint": endpoint}
	m.requests.DeletePartialMatch(labels)
	m.bytes.DeletePartialMatch(labels)
	m.duration.DeletePartialMatch(labels)
	m.ttfb.DeletePartialMatch(labels)
	m.transitions.DeletePartialMatch(labels)
	m.attestations.DeletePartialMatch(labels)
	m.admitted.DeletePartialMatch(labels)
	m.listening.DeletePartialMatch(labels)
}

// counters are the per-endpoint totals the dashboard and `gatekeeper status`
// show. They duplicate a little of what Prometheus holds because the TUI must
// work with no metrics listener configured at all.
//
// The totals are atomic rather than mutex-guarded: they are written from every
// read and every write of every proxied request, and the mutex is only for the
// rate, which one goroutine recomputes on the publish tick.
type counters struct {
	requests atomic.Uint64
	bytesIn  atomic.Int64
	bytesOut atomic.Int64

	mu sync.Mutex
	// rate is requests per second over the last publish interval, recomputed by
	// [counters.sample] rather than decayed continuously: the dashboard reads it
	// at the same cadence it is written.
	rate       float64
	lastCount  uint64
	lastSample time.Time
}

func (c *counters) request()       { c.requests.Add(1) }
func (c *counters) addIn(n int64)  { c.bytesIn.Add(n) }
func (c *counters) addOut(n int64) { c.bytesOut.Add(n) }

// sample recomputes the request rate at instant now.
func (c *counters) sample(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	requests := c.requests.Load()
	if !c.lastSample.IsZero() {
		if elapsed := now.Sub(c.lastSample).Seconds(); elapsed > 0 {
			c.rate = float64(requests-c.lastCount) / elapsed
		}
	}
	c.lastCount, c.lastSample = requests, now
}

func (c *counters) read() (rate float64, in, out int64) {
	c.mu.Lock()
	rate = c.rate
	c.mu.Unlock()
	return rate, c.bytesIn.Load(), c.bytesOut.Load()
}

// reset zeroes the counters, which is what stopping a listener does to them:
// the dashboard shows traffic for the current run of an endpoint, not a total
// that survives it being taken down and brought back.
func (c *counters) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests.Store(0)
	c.bytesIn.Store(0)
	c.bytesOut.Store(0)
	c.rate, c.lastCount, c.lastSample = 0, 0, time.Time{}
}
