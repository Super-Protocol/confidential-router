package proxy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/verifier"
)

// PublishInterval is how often a running supervisor publishes a full snapshot
// to its subscribers, and how often the request-rate counters are recomputed.
const PublishInterval = time.Second

// ReconcileInterval is how often the supervisor re-checks that every endpoint
// its configuration declares is actually holding a listener, and brings back
// the ones that are not (SUP-537).
//
// An endpoint that should be serving and is not is a fail-closed outage: every
// request to it is refused, and under `failMode: closed` that is the whole of
// the endpoint. Ten seconds recovers one well inside a single re-attestation
// window while leaving a genuinely unbindable address to be retried six times a
// minute rather than continuously.
const ReconcileInterval = 10 * time.Second

// DialFunc opens a TCP connection. It is the seam an embedder — or a test that
// has to reach a loopback listener under the hostname the evidence is published
// for — plugs its own transport into.
type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// VerifierFunc builds the verification seam for one configuration. It is a
// factory rather than a value because a reload changes the trust store and the
// policy set, and a verdict formed against the old ones would be stale in the
// one way that matters.
type VerifierFunc func(ctx context.Context, cfg *config.Config) (status.Verifier, error)

// Options configures [New]. Only Config is required.
type Options struct {
	Config *config.Config

	// Verifier builds the pipeline verdicts come from. Nil uses pkg/verifier,
	// which is the real one.
	Verifier VerifierFunc
	// Dial opens upstream connections, for both the evidence fetch and the
	// proxied traffic. Nil uses a plain net.Dialer.
	Dial DialFunc
	// Now overrides the clock. Nil means time.Now.
	Now func() time.Time
	// Registry collects the Prometheus metrics. Nil creates a private registry,
	// which is what a single-process gatekeeper wants.
	Registry *prometheus.Registry
	// PublishInterval overrides [PublishInterval].
	PublishInterval time.Duration
	// ReconcileInterval overrides [ReconcileInterval]. A negative value turns
	// reconciliation off, which nothing in production does — it exists for a
	// test that asserts on the unreconciled state.
	ReconcileInterval time.Duration
	// DenyBackoff replaces the denied-endpoint retry schedule with one fixed
	// delay. Zero means the built-in schedule: [onDemandRetry], doubling to
	// [denyBackoffMax]. Nothing in production sets it; it exists so that a test
	// counting evidence fetches can keep the background loop out of its way,
	// the way PublishInterval keeps the snapshot loop out of it.
	DenyBackoff time.Duration
}

// Supervisor runs the data plane: one listener per endpoint, each with its own
// verdict, its own re-attestation loop and its own connection pools.
//
// It implements [status.Supervisor] and [status.Reloader], which is the whole
// surface `gatekeeper run`, `gatekeeper status` and the dashboard see.
type Supervisor struct {
	opts    Options
	bus     *bus
	metrics *metrics
	audit   *auditor
	servers []*localServer

	cancel        context.CancelFunc
	loopDone      chan struct{}
	reconcileDone chan struct{}

	mu        sync.RWMutex
	cfg       *config.Config
	verifier  status.Verifier
	endpoints []*endpoint
	closed    bool
}

// New builds a supervisor from a validated configuration. It binds the admin
// and metrics listeners, if any, but no endpoint listener: [Supervisor.Start]
// does that, so a caller decides what comes up and can report what did not.
//
// It does start the background loops, and one of them is [Supervisor.reconcile]
// — so an endpoint the configuration declares comes up within a reconcile
// interval whether or not the caller ever asks for it. Start is how a caller
// gets it *now*, and how it learns why it did not; it is no longer the only way
// an endpoint ends up served. A caller that wants nothing listening until it
// says so sets a negative [Options.ReconcileInterval].
func New(ctx context.Context, opts Options) (*Supervisor, error) {
	if opts.Config == nil {
		return nil, errors.New("proxy: a configuration is required")
	}
	if opts.Verifier == nil {
		opts.Verifier = func(ctx context.Context, cfg *config.Config) (status.Verifier, error) {
			built, err := verifier.New(ctx, cfg)
			if err != nil {
				return nil, err
			}
			return built.WithDialer(opts.Dial), nil
		}
	}
	if opts.PublishInterval <= 0 {
		opts.PublishInterval = PublishInterval
	}
	if opts.ReconcileInterval == 0 {
		opts.ReconcileInterval = ReconcileInterval
	}

	s := &Supervisor{opts: opts, bus: newBus(), metrics: newMetrics(opts.Registry)}
	built, err := opts.Verifier(ctx, opts.Config)
	if err != nil {
		return nil, err
	}
	s.cfg, s.verifier = opts.Config, built
	if s.endpoints, err = s.build(opts.Config); err != nil {
		return nil, err
	}
	if opts.Config.Audit != nil {
		if s.audit, err = openAudit(opts.Config.Resolve(opts.Config.Audit.File)); err != nil {
			return nil, err
		}
	}
	if err := s.serveLocal(opts.Config); err != nil {
		_ = s.audit.Close()
		return nil, err
	}

	loopCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	s.cancel, s.loopDone = cancel, make(chan struct{})
	go s.publishLoop(loopCtx)
	if opts.ReconcileInterval > 0 {
		s.reconcileDone = make(chan struct{})
		go s.reconcileLoop(loopCtx)
	}
	return s, nil
}

func (s *Supervisor) build(cfg *config.Config) ([]*endpoint, error) {
	out := make([]*endpoint, 0, len(cfg.Endpoints))
	for _, spec := range cfg.Endpoints {
		ep, err := newEndpoint(s, spec, cfg.Tuning(spec))
		if err != nil {
			return nil, err
		}
		out = append(out, ep)
	}
	return out, nil
}

// denyBackoff is the first delay of the schedule a denied endpoint re-checks on.
func (s *Supervisor) denyBackoff() time.Duration {
	if s.opts.DenyBackoff > 0 {
		return s.opts.DenyBackoff
	}
	return onDemandRetry
}

// denyBackoffMax is that schedule's ceiling. An override is a fixed delay, so
// it is its own ceiling.
func (s *Supervisor) denyBackoffMax() time.Duration {
	if s.opts.DenyBackoff > 0 {
		return s.opts.DenyBackoff
	}
	return denyBackoffMax
}

func (s *Supervisor) now() time.Time {
	if s.opts.Now != nil {
		return s.opts.Now()
	}
	return time.Now()
}

// verify runs the current verification seam. It is read under the lock so that
// a reload swapping the verifier cannot be observed half-applied.
func (s *Supervisor) verify(ctx context.Context, req status.VerifyRequest) (*status.Report, error) {
	s.mu.RLock()
	v := s.verifier
	s.mu.RUnlock()
	if v == nil {
		return nil, errors.New("no verifier is configured")
	}
	return v.Verify(ctx, req)
}

func (s *Supervisor) log(level, endpoint, message string) {
	s.bus.log(s.now(), level, endpoint, message)
}

// Snapshot implements [status.Supervisor].
func (s *Supervisor) Snapshot(context.Context) status.Snapshot {
	s.mu.RLock()
	endpoints := s.endpoints
	s.mu.RUnlock()

	out := status.Snapshot{At: s.now(), Endpoints: make([]status.Endpoint, 0, len(endpoints))}
	for _, ep := range endpoints {
		out.Endpoints = append(out.Endpoints, ep.snapshot())
	}
	return out
}

// Events implements [status.Supervisor].
func (s *Supervisor) Events(ctx context.Context) <-chan status.Event {
	return s.bus.subscribe(ctx)
}

// Start implements [status.Supervisor].
func (s *Supervisor) Start(ctx context.Context, name string) error {
	ep, err := s.endpoint(name)
	if err != nil {
		return err
	}
	// Recorded before the attempt, so that an endpoint whose address is taken
	// right now is still an endpoint this gatekeeper is trying to serve, and
	// [Supervisor.reconcile] keeps trying.
	ep.setDesired(true)
	if err := ep.start(ctx); err != nil {
		s.publishSnapshot()
		return err
	}
	s.publishSnapshot()
	return nil
}

// Stop implements [status.Supervisor].
//
// This is the operator's switch — the dashboard's `s` key, and the drain on the
// way out — so it is also what tells [Supervisor.reconcile] to leave the
// endpoint alone. A listener that went away for any other reason is one the
// configuration still asks for, and gets brought back.
func (s *Supervisor) Stop(ctx context.Context, name string) error {
	ep, err := s.endpoint(name)
	if err != nil {
		return err
	}
	ep.setDesired(false)
	err = ep.stop(ctx)
	s.publishSnapshot()
	return err
}

// Reattest implements [status.Supervisor]: a fresh verification, bypassing the
// verdict cache, which is what the dashboard's `r` key and a user who has just
// changed a pin are asking for.
func (s *Supervisor) Reattest(ctx context.Context, name string) (*status.Report, error) {
	ep, err := s.endpoint(name)
	if err != nil {
		return nil, err
	}
	result := ep.attest(ctx, forceAttest)
	if result == nil {
		return nil, errors.New("re-attestation produced no verdict")
	}
	return result.Report, nil
}

// Reload implements [status.Reloader].
//
// Endpoints whose listener, upstream and tuning are unchanged keep running with
// their connections intact: a SIGHUP that added a trusted root must not drop a
// completion that is halfway through streaming. Everything else is rebuilt, and
// every endpoint is re-verified, because the pins and policies behind its
// verdict may be exactly what changed.
func (s *Supervisor) Reload(ctx context.Context, cfg *config.Config) error {
	built, err := s.opts.Verifier(ctx, cfg)
	if err != nil {
		return err
	}

	s.mu.Lock()
	previous := s.endpoints
	kept := make([]*endpoint, 0, len(cfg.Endpoints))
	var added []*endpoint
	surviving := map[string]bool{}

	for _, spec := range cfg.Endpoints {
		tuning := cfg.Tuning(spec)
		if existing := findEndpoint(previous, spec.Name); existing != nil && existing.sameSpec(spec, tuning) {
			surviving[spec.Name] = true
			kept = append(kept, existing)
			continue
		}
		ep, err := newEndpoint(s, spec, tuning)
		if err != nil {
			s.mu.Unlock()
			return err
		}
		kept = append(kept, ep)
		added = append(added, ep)
	}

	var retired []*endpoint
	for _, ep := range previous {
		if !surviving[ep.name] {
			retired = append(retired, ep)
		}
	}
	s.cfg, s.verifier, s.endpoints = cfg, built, kept
	s.mu.Unlock()

	// Retiring comes first: an endpoint whose spec changed is retired and rebuilt
	// under the same name, and the replacement cannot bind a listener the
	// predecessor still holds.
	for _, ep := range retired {
		wasRunning := ep.isRunning()
		// No longer named by the configuration, so no longer wanted. Without
		// this a reconcile pass that began before the swap could bind the
		// address its replacement needs, leaving the replacement permanently
		// unable to bind and an invisible listener — absent from s.endpoints,
		// so absent from every snapshot — forwarding to a retired upstream.
		ep.setDesired(false)
		_ = ep.stop(ctx)
		s.metrics.forget(ep.name)
		if wasRunning {
			s.log("info", ep.name, "endpoint removed by reload")
		}
	}
	for _, ep := range added {
		// An endpoint rebuilt under a name that was already running comes up
		// here, at once, so a changed upstream or listen address does not cost
		// its traffic a reconcile interval. A name appearing for the first time
		// is left to [Supervisor.reconcile], which is what makes it arrive at
		// all — nothing else in this process would ever have started it
		// (SUP-338, SUP-537).
		if replaced := findEndpoint(retired, ep.name); replaced == nil {
			continue
		}
		if err := ep.start(ctx); err != nil {
			s.log("error", ep.name, "could not start after reload: "+err.Error())
		}
	}
	// Pins and policies may have changed under an endpoint that kept running,
	// so its verdict is re-formed rather than carried over.
	for _, ep := range kept {
		if ep.isRunning() {
			go ep.attest(context.WithoutCancel(ctx), forceAttest)
		}
	}

	s.log("info", "", "configuration reloaded")
	s.publishSnapshot()
	return nil
}

func findEndpoint(list []*endpoint, name string) *endpoint {
	for _, ep := range list {
		if ep.name == name {
			return ep
		}
	}
	return nil
}

func (e *endpoint) isRunning() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.running
}

func (s *Supervisor) endpoint(name string) (*endpoint, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if ep := findEndpoint(s.endpoints, name); ep != nil {
		return ep, nil
	}
	return nil, fmt.Errorf("no endpoint named %q", name)
}

// publishSnapshot pushes the current state to every subscriber. It is called
// whenever something changed rather than only on the tick, so a dashboard shows
// a verdict flip at the moment it happens.
func (s *Supervisor) publishSnapshot() {
	snapshot := s.Snapshot(context.Background())
	s.bus.publish(status.Event{Kind: status.EventSnapshot, Snapshot: &snapshot})
}

// reconcileLoop closes the gap between the endpoints the configuration declares
// and the ones that hold a listener (SUP-537).
//
// Why a loop rather than one more call site. Every route into this data plane
// starts an endpoint at the moment it learns of it — `run` at boot, a reload for
// what it added, the dashboard on demand — and each of those is one chance to
// get it right, after which nothing looks again. A parked production rollback
// spent an afternoon `PENDING` with `lastReason: "listener stopped"` and
// `lastCheckedAt` null: reachable on every surface an operator checks, unable
// to serve a single completion, with no retry and nothing that escalated. The
// loop replaces "whoever noticed first starts it" with a standing answer to
// "should this be serving, and is it".
//
// Binding is not a trust decision, so this cannot open anything: a fresh
// listener admits nothing until its own verification completes (ADR-003 §7),
// and the pins and policies it is held to are the ones in force now. The only
// state it will not override is an operator's — see [Supervisor.Stop].
func (s *Supervisor) reconcileLoop(ctx context.Context) {
	defer close(s.reconcileDone)
	ticker := time.NewTicker(s.opts.ReconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.reconcile(ctx)
		}
	}
}

// reconcile starts every endpoint that should be serving and is not. It
// reports how many it brought back, which is what the tests assert on.
func (s *Supervisor) reconcile(ctx context.Context) int {
	s.mu.RLock()
	endpoints, closed := s.endpoints, s.closed
	s.mu.RUnlock()
	if closed {
		return 0
	}

	restarted := 0
	for _, ep := range endpoints {
		if !ep.desired() || ep.isRunning() {
			continue
		}
		// Still the endpoint the configuration in force declares? A reload may
		// have retired this one since the pass began, and binding the address
		// its replacement is about to take would be worse than doing nothing.
		if current, err := s.endpoint(ep.name); err != nil || current != ep {
			continue
		}
		// retry() re-checks the intent under the endpoint's own lock, so the
		// desired() call above is a cheap filter rather than the guard. It
		// leaves a bind failure on the endpoint — and so in the snapshot the
		// console reads as `lastReason` — without writing a log line per
		// attempt. A silent `stopped` is the one outcome this loop exists to
		// make impossible.
		started, err := ep.retry(ctx)
		if err != nil || !started {
			continue
		}
		s.log("info", ep.name, "listener was not running and has been started")
		restarted++
	}
	if restarted > 0 {
		s.publishSnapshot()
	}
	return restarted
}

// publishLoop recomputes the request rates and publishes a snapshot on every
// tick, which is what keeps the dashboard's counters moving.
func (s *Supervisor) publishLoop(ctx context.Context) {
	defer close(s.loopDone)
	ticker := time.NewTicker(s.opts.PublishInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.mu.RLock()
			endpoints := s.endpoints
			s.mu.RUnlock()
			for _, ep := range endpoints {
				ep.stats.sample(now)
			}
			s.publishSnapshot()
		}
	}
}

// Close stops every listener, the local servers and the event stream. The
// supervisor cannot be used afterwards.
func (s *Supervisor) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	endpoints, servers := s.endpoints, s.servers
	s.servers = nil
	s.mu.Unlock()

	// The background loops go first, and are waited for. The reconcile loop's
	// whole purpose is to start a listener that is not running, so a pass still
	// in flight would otherwise race the stops below and leave a bound socket
	// behind a closed supervisor.
	if s.cancel != nil {
		s.cancel()
		<-s.loopDone
		if s.reconcileDone != nil {
			<-s.reconcileDone
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, ep := range endpoints {
		_ = ep.stop(ctx)
	}
	for _, server := range servers {
		_ = server.Close()
	}
	s.bus.close()
	return s.audit.Close()
}
