package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// The two kinds of local server a gatekeeper can bring up. Both are read-only
// and local-only; neither can change a verdict or a pin.
const (
	// ServerAdmin is the full status API: /healthz, /status, /endpoints,
	// /verdicts and /metrics.
	ServerAdmin = "admin"
	// ServerMetrics is `metrics.listen`, which serves /metrics and /healthz and
	// nothing that names a verdict.
	ServerMetrics = "metrics"
)

// localServer is one bound admin or metrics listener.
type localServer struct {
	kind string
	addr string
	// socket is the unix socket path to remove on close, empty for TCP.
	socket string
	server *http.Server
}

func (l *localServer) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := l.server.Shutdown(ctx)
	if l.socket != "" {
		_ = os.Remove(l.socket)
	}
	return err
}

// serveLocal brings up whichever of the admin and metrics listeners the
// configuration asks for.
func (s *Supervisor) serveLocal(cfg *config.Config) error {
	if cfg.Admin != nil {
		server, err := listenLocal(ServerAdmin, cfg.Admin.Listen, s.adminHandler())
		if err != nil {
			return err
		}
		s.servers = append(s.servers, server)
	}
	if cfg.Metrics != nil {
		server, err := listenLocal(ServerMetrics, cfg.Metrics.Listen, s.metricsHandler())
		if err != nil {
			s.closeServers()
			return err
		}
		s.servers = append(s.servers, server)
	}
	return nil
}

func (s *Supervisor) closeServers() {
	for _, server := range s.servers {
		_ = server.Close()
	}
	s.servers = nil
}

// listenLocal binds one local server. `unix:<path>` replaces a stale socket
// left by a previous run and makes the new one owner-only — the socket answers
// with verdicts, and file permissions are the only access control a unix socket
// has.
func listenLocal(kind, addr string, handler http.Handler) (*localServer, error) {
	server := &localServer{kind: kind, server: &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}}

	network, target := "tcp", addr
	if socket, ok := strings.CutPrefix(addr, "unix:"); ok {
		network, target, server.socket = "unix", socket, socket
		if err := os.MkdirAll(filepath.Dir(socket), 0o700); err != nil {
			return nil, fmt.Errorf("%s listener: %w", kind, err)
		}
		if err := removeStaleSocket(socket); err != nil {
			return nil, fmt.Errorf("%s listener: %w", kind, err)
		}
	}

	listener, err := net.Listen(network, target)
	if err != nil {
		return nil, fmt.Errorf("%s listener: %w", kind, err)
	}
	if server.socket != "" {
		if err := os.Chmod(server.socket, 0o600); err != nil {
			_ = listener.Close()
			return nil, fmt.Errorf("%s listener: %w", kind, err)
		}
	}
	server.addr = listener.Addr().String()
	go func() {
		if err := server.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			_ = listener.Close()
		}
	}()
	return server, nil
}

// removeStaleSocket deletes a socket file no process is listening on. A socket
// something *is* listening on is left alone, so a second gatekeeper fails to
// bind instead of silently stealing the first one's admin API.
func removeStaleSocket(path string) error {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("%s exists and is not a socket", path)
	}
	conn, err := net.DialTimeout("unix", path, 200*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		return fmt.Errorf("%s is already in use — another gatekeeper is running", path)
	}
	return os.Remove(path)
}

// adminHandler is the full local status API.
//
// Everything it serves is a read. There is no route that starts, stops, pins or
// re-attests: a socket that could change what the gatekeeper trusts would be a
// far more interesting target than one that can only describe it.
func (s *Supervisor) adminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, s.Snapshot(r.Context()))
	})
	mux.HandleFunc("GET /endpoints", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, s.Snapshot(r.Context()).Endpoints)
	})
	mux.HandleFunc("GET /verdicts", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, verdictsOf(s.Snapshot(r.Context())))
	})
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.metrics.registry, promhttp.HandlerOpts{}))
	return mux
}

// metricsHandler is `metrics.listen`: scrape data and a liveness check, and
// deliberately nothing else. A Prometheus endpoint tends to end up reachable
// from more places than its operator remembers, and the verdict routes name
// hostnames, digests and the reason each denial happened.
func (s *Supervisor) metricsHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.metrics.registry, promhttp.HandlerOpts{}))
	return mux
}

// Health is what /healthz answers: the process is up, and how many endpoints
// are in each state.
type Health struct {
	Status string `json:"status"`
	// Endpoints is the number of configured endpoints, Listening how many hold
	// a bound listener, and Confidential how many are admitting traffic.
	Endpoints    int `json:"endpoints"`
	Listening    int `json:"listening"`
	Confidential int `json:"confidential"`
}

func (s *Supervisor) handleHealth(w http.ResponseWriter, r *http.Request) {
	snapshot := s.Snapshot(r.Context())
	health := Health{Status: "ok", Endpoints: len(snapshot.Endpoints)}
	for _, ep := range snapshot.Endpoints {
		if ep.Health != status.Stopped {
			health.Listening++
		}
		if ep.Health.Trusted() {
			health.Confidential++
		}
	}
	writeJSON(w, health)
}

// Verdict is one endpoint's entry in /verdicts: its current decision and the
// report behind it.
type Verdict struct {
	Endpoint string         `json:"endpoint"`
	Health   status.Health  `json:"health"`
	Admitted bool           `json:"admitted"`
	Reason   string         `json:"reason,omitempty"`
	Report   *status.Report `json:"report,omitempty"`
}

func verdictsOf(snapshot status.Snapshot) []Verdict {
	out := make([]Verdict, 0, len(snapshot.Endpoints))
	for _, ep := range snapshot.Endpoints {
		out = append(out, Verdict{
			Endpoint: ep.Name, Health: ep.Health, Reason: ep.Reason,
			Admitted: ep.Report != nil && ep.Report.Admitted, Report: ep.Report,
		})
	}
	return out
}

func writeJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(body)
}
