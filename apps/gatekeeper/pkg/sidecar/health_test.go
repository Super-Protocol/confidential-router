package sidecar_test

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/sidecar"
)

// A stand-in admin API: the one route the probe reads, on loopback, like the
// real one. `serve` is what it answers /healthz with, or nothing at all when it
// is nil — a listener that accepts and never replies, which is the shape of the
// failure this probe exists for.
func fakeAdmin(t *testing.T, serve http.HandlerFunc) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("binding a stand-in admin API: %v", err)
	}
	server := &http.Server{Handler: serve} //nolint:gosec // a loopback test server
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return listener.Addr().String()
}

// A runnable configuration whose admin listener is `listen`.
func configWithAdmin(listen string) string {
	return runnableConfig + fmt.Sprintf("admin:\n  listen: %s\n", listen)
}

func check(t *testing.T, path string) (int, string) {
	t.Helper()
	out := &syncWriter{}
	code := sidecar.Healthcheck(context.Background(), path, out)
	return code, out.String()
}

// The state every deployment ships in. router-api renders an empty endpoint
// list until an admin registers an upstream, the supervisor waits on it, and
// there is no admin listener to probe — so the obvious `httpGet` probe would
// restart this container for ever over a deployment that has done nothing
// wrong. That is why the chart had no probe at all, and why this one is an
// `exec`.
func TestHealthyWhileWaitingForAnEndpoint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, "version: 1\nendpoints: []\n")

	code, out := check(t, path)

	if code != 0 {
		t.Fatalf("exit %d, want 0 — a waiting sidecar must not be restarted: %s", code, out)
	}
	if !strings.Contains(out, "waiting for") {
		t.Errorf("the reason is not in the output: %q", out)
	}
}

func TestHealthyBeforeTheConfigExistsAtAll(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")

	if code, out := check(t, path); code != 0 {
		t.Fatalf("exit %d, want 0: %s", code, out)
	}
}

// A render in flight: `os.WriteFile` truncates before it writes, so the file is
// briefly observable half-written. The next probe sees the finished one.
func TestHealthyWhileTheConfigIsHalfWritten(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, "version: 1\nendpoi")

	if code, out := check(t, path); code != 0 {
		t.Fatalf("exit %d, want 0: %s", code, out)
	}
}

func TestHealthyWhenTheAdminAPIAnswers(t *testing.T) {
	listen := fakeAdmin(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","endpoints":1,"listening":1,"confidential":1}`))
	})
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, configWithAdmin(listen))

	code, out := check(t, path)

	if code != 0 {
		t.Fatalf("exit %d, want 0: %s", code, out)
	}
	// What it reports is what the gatekeeper said, so `kubectl describe` on a
	// flapping probe shows the state rather than only the verdict on it.
	if !strings.Contains(out, "1 endpoint(s), 1 listening, 1 admitting") {
		t.Errorf("the counts are not in the output: %q", out)
	}
}

// The defect. Production held this state for 4.5 days with `restartCount: 0`,
// `Ready: true` and nothing watching: the configuration is runnable, so the
// gatekeeper should be answering, and it is not.
func TestUnhealthyWhenTheAdminAPIIsNotListening(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	// Port 1 on loopback: nothing binds it, so the dial is refused at once.
	writeConfig(t, path, configWithAdmin("127.0.0.1:1"))

	code, out := check(t, path)

	if code != 1 {
		t.Fatalf("exit %d, want 1 — a wedged gatekeeper is what the probe is for: %s", code, out)
	}
	if !strings.Contains(out, "did not answer") {
		t.Errorf("the output does not say what failed: %q", out)
	}
}

func TestUnhealthyWhenTheAdminAPIRefuses(t *testing.T) {
	listen := fakeAdmin(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, configWithAdmin(listen))

	if code, out := check(t, path); code != 1 {
		t.Fatalf("exit %d, want 1: %s", code, out)
	}
}

// A denial is not a reason to restart anything: the gatekeeper is refusing an
// endpoint on purpose, a restart would re-run the same refusal, and it would
// drop every working endpoint beside it. "Is it serving?" is the console's
// question; this one is "is it answering?".
func TestHealthyWhenEveryEndpointIsRefused(t *testing.T) {
	listen := fakeAdmin(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","endpoints":2,"listening":2,"confidential":0}`))
	})
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, configWithAdmin(listen))

	code, out := check(t, path)

	if code != 0 {
		t.Fatalf("exit %d, want 0 — a fail-closed endpoint is a verdict, not a wedged process: %s", code, out)
	}
	if !strings.Contains(out, "0 admitting") {
		t.Errorf("the counts are not in the output: %q", out)
	}
}

// A configuration with no admin listener was never meant to be readable. Saying
// "unhealthy" there would restart a container over a setting.
func TestHealthyWhenNoAdminListenerIsConfigured(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, runnableConfig)

	code, out := check(t, path)

	if code != 0 {
		t.Fatalf("exit %d, want 0: %s", code, out)
	}
	if !strings.Contains(out, "no admin listener") {
		t.Errorf("the output does not say why there was nothing to check: %q", out)
	}
}

func TestHealthcheckRequiresAConfigPath(t *testing.T) {
	if code, _ := check(t, ""); code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
}

// The listener is loopback-only and the probe runs inside the container, so the
// two meet without the sidecar growing a listener on the pod IP — the
// reachability ADR-008 deliberately does not grant it.
func TestItReadsALoopbackListenerAndNotTheHostInterface(t *testing.T) {
	listen := fakeAdmin(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	if !strings.HasPrefix(listen, "127.0.0.1:") {
		t.Fatalf("the stand-in bound %s, which is not loopback", listen)
	}
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, configWithAdmin(listen))

	if code, out := check(t, path); code != 0 {
		t.Fatalf("exit %d, want 0: %s", code, out)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the probe should not have touched the file: %v", err)
	}
}
