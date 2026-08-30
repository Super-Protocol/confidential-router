package status

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// DemoTick is how often a demo supervisor publishes a snapshot.
const DemoTick = 500 * time.Millisecond

// demoAttestAfter is how many ticks an endpoint spends in Attesting before it
// reaches its scripted verdict — long enough to see the state on screen.
const demoAttestAfter = 3

// Demo is a [Supervisor] and a [Verifier] that never touches the network.
//
// It exists for two reasons: the TUI has to be reviewable and screenshot-able
// before the data plane (SUP-71) lands, and a dashboard driven only by a real
// proxy is untestable. Every number it reports is derived from the tick counter
// and the endpoint's position in the config, so two runs of the same length
// produce the same screen.
//
// It is not a mock of the proxy and must never be wired into `run` without
// --demo: nothing here verifies anything, and every report it produces is
// marked as such in Warnings.
type Demo struct {
	mu        sync.Mutex
	endpoints []Endpoint
	scripted  []Health
	started   map[string]bool
	ticks     map[string]int
	now       func() time.Time
	logs      []LogLine
}

// NewDemo builds a demo supervisor from a config. Endpoints keep their real
// names, listen addresses, upstreams and fail modes; only their state is
// invented.
func NewDemo(cfg *config.Config) *Demo {
	d := &Demo{started: map[string]bool{}, ticks: map[string]int{}, now: time.Now}
	for i, ep := range cfg.Endpoints {
		tuning := cfg.Tuning(ep)
		d.endpoints = append(d.endpoints, Endpoint{
			Name:     ep.Name,
			Listen:   ep.Listen,
			Upstream: ep.Upstream,
			FailMode: tuning.FailMode,
			Health:   Attesting,
		})
		d.started[ep.Name] = true
		// One endpoint is scripted to fail, so the dashboard shows both halves
		// of the fail-mode story rather than a screen of green rows.
		scripted := Confidential
		if i == 1 {
			scripted = Broken
			if tuning.FailMode == config.FailOpen {
				scripted = NonConfidential
			}
		}
		d.scripted = append(d.scripted, scripted)
	}
	return d
}

// WithClock replaces the demo's clock, which is what makes its output
// reproducible in tests.
func (d *Demo) WithClock(now func() time.Time) *Demo {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.now = now
	return d
}

// Snapshot implements [Supervisor].
func (d *Demo) Snapshot(context.Context) Snapshot {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.snapshotLocked()
}

func (d *Demo) snapshotLocked() Snapshot {
	out := Snapshot{At: d.now(), Endpoints: make([]Endpoint, 0, len(d.endpoints))}
	for i := range d.endpoints {
		out.Endpoints = append(out.Endpoints, d.resolve(i))
	}
	return out
}

// resolve renders one endpoint at its current tick count.
func (d *Demo) resolve(i int) Endpoint {
	ep := d.endpoints[i]
	if !d.started[ep.Name] {
		ep.Health = Stopped
		ep.Reason = "listener stopped"
		ep.RequestsPerSecond, ep.BytesIn, ep.BytesOut = 0, 0, 0
		return ep
	}

	ticks := d.ticks[ep.Name]
	if ticks < demoAttestAfter {
		ep.Health = Attesting
		ep.Reason = "waiting for the first verdict"
		return ep
	}

	ep.Health = d.scripted[i]
	ep.LastAttestAt = d.now().Add(-time.Duration(ticks-demoAttestAfter) * DemoTick)
	ep.NextAttestAt = ep.LastAttestAt.Add(5 * time.Minute)
	ep.Report = demoReport(ep, ep.Health, ep.LastAttestAt)
	ep.PublishedDigest = ep.Report.EvidenceDigest
	if ep.Health != Confidential {
		ep.Reason = ep.Report.Denied()
	}
	// Traffic only flows in the serving states, and the counters are a
	// deterministic function of how long it has been flowing.
	if ep.Health.Serving() {
		served := ticks - demoAttestAfter + 1
		ep.RequestsPerSecond = float64((i*7+served*3)%40) / 4
		ep.BytesIn = int64(served) * int64(1024+i*311)
		ep.BytesOut = int64(served) * int64(7168+i*907)
	}
	return ep
}

// demoReport invents a plausible verification result for one endpoint.
func demoReport(ep Endpoint, health Health, at time.Time) *Report {
	hostname := hostnameOf(ep.Upstream)
	digest := trust.Sum([]byte("demo evidence " + ep.Name)).String()
	rootFP := trust.Sum([]byte("demo root " + ep.Name)).String()
	leafFP := trust.Sum([]byte("demo leaf " + ep.Name)).String()

	report := &Report{
		Endpoint:               ep.Name,
		Hostname:               hostname,
		Port:                   443,
		CheckedAt:              at,
		Kind:                   "DeploymentEvidence",
		IssuedAt:               at.Add(-2 * time.Minute),
		EvidenceDigest:         digest,
		ObservedTLSFingerprint: leafFP,
		CertFingerprint:        leafFP,
		RootFingerprint:        rootFP,
		QuoteFormat:            "tdx-v4",
		Images: []string{
			"ghcr.io/super-protocol/vllm@sha256:8f1c...c2a1",
			"ghcr.io/super-protocol/router-sidecar@sha256:41ab...9d7e",
		},
		Chain: []Certificate{
			{Subject: "CN=" + hostname, Issuer: "CN=demo-intermediate", Fingerprint: leafFP,
				NotBefore: at.Add(-24 * time.Hour), NotAfter: at.Add(720 * time.Hour)},
			{Subject: "CN=demo-intermediate", Issuer: "CN=demo-root", Fingerprint: trust.Sum([]byte("demo intermediate")).String(),
				NotBefore: at.Add(-2400 * time.Hour), NotAfter: at.Add(24000 * time.Hour)},
			{Subject: "CN=demo-root", Issuer: "CN=demo-root", Fingerprint: rootFP,
				NotBefore: at.Add(-8000 * time.Hour), NotAfter: at.Add(80000 * time.Hour), Root: true},
		},
		Warnings: []string{"DEMO DATA: nothing was fetched, verified or evaluated"},
	}

	switch health {
	case Broken:
		report.Stage = "untrusted-root"
		report.Reason = "the chain terminates in " + rootFP + ", which is not a trusted root"
		report.UntrustedRoot = rootFP
	case NonConfidential:
		report.Verified = true
		report.Root = "demo-root"
		report.Policies = []PolicyResult{{Package: "gatekeeper.default", Allow: false}}
		report.Reason = "the published evidenceDigest is not pinned for this endpoint"
	default:
		report.Verified = true
		report.Admitted = true
		report.Pinned = true
		report.Root = "demo-root"
		report.Policies = []PolicyResult{{Package: "gatekeeper.default", Allow: true}}
	}
	return report
}

// Events implements [Supervisor]: a snapshot every [DemoTick], with a log line
// whenever an endpoint changes state.
func (d *Demo) Events(ctx context.Context) <-chan Event {
	out := make(chan Event, 16)
	go func() {
		defer close(out)
		ticker := time.NewTicker(DemoTick)
		defer ticker.Stop()
		previous := map[string]Health{}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}

			d.mu.Lock()
			for name := range d.started {
				if d.started[name] {
					d.ticks[name]++
				}
			}
			snapshot := d.snapshotLocked()
			pending := d.logs
			d.logs = nil
			d.mu.Unlock()

			for _, ep := range snapshot.Endpoints {
				if was, seen := previous[ep.Name]; !seen || was != ep.Health {
					pending = append(pending, LogLine{
						At: snapshot.At, Level: levelFor(ep.Health), Endpoint: ep.Name,
						Message: message(ep),
					})
				}
				previous[ep.Name] = ep.Health
			}
			for i := range pending {
				if !send(ctx, out, Event{Kind: EventLog, Log: &pending[i]}) {
					return
				}
			}
			if !send(ctx, out, Event{Kind: EventSnapshot, Snapshot: &snapshot}) {
				return
			}
		}
	}()
	return out
}

func send(ctx context.Context, out chan<- Event, ev Event) bool {
	select {
	case <-ctx.Done():
		return false
	case out <- ev:
		return true
	}
}

// Start implements [Supervisor].
func (d *Demo) Start(_ context.Context, endpoint string) error {
	return d.set(endpoint, true)
}

// Stop implements [Supervisor].
func (d *Demo) Stop(_ context.Context, endpoint string) error {
	return d.set(endpoint, false)
}

func (d *Demo) set(endpoint string, running bool) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.started[endpoint]; !ok {
		return fmt.Errorf("no endpoint named %q", endpoint)
	}
	d.started[endpoint] = running
	if !running {
		d.ticks[endpoint] = 0
	}
	verb := "stopped"
	if running {
		verb = "started"
	}
	d.logs = append(d.logs, LogLine{At: d.now(), Level: "info", Endpoint: endpoint, Message: "listener " + verb})
	return nil
}

// Reattest implements [Supervisor] by restarting the endpoint's attestation
// clock, which is what a real re-check looks like from the dashboard.
func (d *Demo) Reattest(_ context.Context, endpoint string) (*Report, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := range d.endpoints {
		if d.endpoints[i].Name != endpoint {
			continue
		}
		d.ticks[endpoint] = demoAttestAfter
		d.logs = append(d.logs, LogLine{
			At: d.now(), Level: "info", Endpoint: endpoint, Message: "re-attestation requested",
		})
		resolved := d.resolve(i)
		return resolved.Report, nil
	}
	return nil, fmt.Errorf("no endpoint named %q", endpoint)
}

// Verify implements [Verifier] against the same invented data.
func (d *Demo) Verify(_ context.Context, req VerifyRequest) (*Report, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := range d.endpoints {
		ep := d.endpoints[i]
		if ep.Name == req.Endpoint || hostnameOf(ep.Upstream) == req.Hostname {
			return demoReport(ep, d.scripted[i], d.now()), nil
		}
	}
	// A host the demo config knows nothing about is denied. This is a
	// status.Verifier: its answer to an unknown question must not be "yes".
	return demoReport(Endpoint{Name: req.Endpoint, Upstream: "https://" + req.Hostname}, Broken, d.now()), nil
}

func levelFor(h Health) string {
	switch h {
	case Broken:
		return "error"
	case NonConfidential:
		return "warn"
	default:
		return "info"
	}
}

func message(ep Endpoint) string {
	if ep.Reason != "" {
		return string(ep.Health) + ": " + ep.Reason
	}
	return string(ep.Health)
}

// hostnameOf reduces an `https://host[:port]` upstream to its host. The config
// layer has already validated the shape, so trimming is enough here.
func hostnameOf(upstream string) string {
	host := strings.TrimPrefix(strings.TrimPrefix(upstream, "https://"), "http://")
	if idx := strings.IndexAny(host, "/:"); idx >= 0 {
		host = host[:idx]
	}
	return host
}

// Reload implements [Reloader]: the demo adopts the new endpoint list, keeping
// the tick counters of endpoints that survived so the dashboard does not blink
// back to "attesting" for everything on every SIGHUP.
func (d *Demo) Reload(_ context.Context, cfg *config.Config) error {
	fresh := NewDemo(cfg)

	d.mu.Lock()
	defer d.mu.Unlock()
	for name, ticks := range d.ticks {
		if _, ok := fresh.started[name]; ok {
			fresh.ticks[name] = ticks
			fresh.started[name] = d.started[name]
		}
	}
	d.endpoints, d.scripted = fresh.endpoints, fresh.scripted
	d.started, d.ticks = fresh.started, fresh.ticks
	d.logs = append(d.logs, LogLine{At: d.now(), Level: "info", Message: "configuration reloaded"})
	return nil
}
