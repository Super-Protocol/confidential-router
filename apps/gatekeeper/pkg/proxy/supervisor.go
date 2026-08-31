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

	cancel   context.CancelFunc
	loopDone chan struct{}

	mu        sync.RWMutex
	cfg       *config.Config
	verifier  status.Verifier
	endpoints []*endpoint
	closed    bool
}

// New builds a supervisor from a validated configuration. It binds the admin
// and metrics listeners, if any, but no endpoint listener: [Supervisor.Start]
// does that, so a caller decides what comes up and can report what did not.
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
	if err := ep.start(ctx); err != nil {
		s.publishSnapshot()
		return err
	}
	s.publishSnapshot()
	return nil
}

// Stop implements [status.Supervisor].
func (s *Supervisor) Stop(ctx context.Context, name string) error {
	ep, err := s.endpoint(name)
	if err != nil {
		return err
	}
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
	result := ep.attest(ctx, true)
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
		_ = ep.stop(ctx)
		s.metrics.forget(ep.name)
		if wasRunning {
			s.log("info", ep.name, "endpoint removed by reload")
		}
	}
	for _, ep := range added {
		// A new endpoint only comes up if its predecessor was up, or if this is
		// the first time the name appears and the caller starts everything.
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
			go ep.attest(context.WithoutCancel(ctx), true)
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

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, ep := range endpoints {
		_ = ep.stop(ctx)
	}
	for _, server := range servers {
		_ = server.Close()
	}
	if s.cancel != nil {
		s.cancel()
		<-s.loopDone
	}
	s.bus.close()
	return s.audit.Close()
}
