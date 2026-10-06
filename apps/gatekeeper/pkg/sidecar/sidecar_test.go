package sidecar_test

import (
	"bytes"
	"context"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/sidecar"
)

// The supervised process is this test binary re-executed as a stand-in
// gatekeeper: it logs every SIGHUP it receives and exits on SIGTERM, which is
// exactly the surface the real one presents here.
const (
	helperEnv  = "GATEKEEPER_SIDECAR_TEST_HELPER"
	helperExit = "GATEKEEPER_SIDECAR_TEST_EXIT"
)

func TestMain(m *testing.M) {
	switch os.Getenv(helperEnv) {
	case "":
		os.Exit(m.Run())
	case "gatekeeper":
		fakeGatekeeper()
	case "exit":
		code, _ := strconv.Atoi(os.Getenv(helperExit))
		os.Exit(code)
	}
}

// fakeGatekeeper mimics `gatekeeper run --headless`: it stays up, prints a line
// per SIGHUP, and drains on SIGTERM.
func fakeGatekeeper() {
	hup := make(chan os.Signal, 8)
	signal.Notify(hup, syscall.SIGHUP)
	term := make(chan os.Signal, 1)
	signal.Notify(term, syscall.SIGTERM)

	os.Stdout.WriteString("gatekeeper: up\n") //nolint:errcheck // stand-in process
	for {
		select {
		case <-hup:
			os.Stdout.WriteString("gatekeeper: reloaded\n") //nolint:errcheck // stand-in process
		case <-term:
			os.Stdout.WriteString("gatekeeper: stopped\n") //nolint:errcheck // stand-in process
			os.Exit(0)
		}
	}
}

// helperCommand is the argv [sidecar.Run] should supervise.
func helperCommand(t *testing.T, mode string, extraEnv ...string) []string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("locating the test binary: %v", err)
	}
	// The environment is how the mode is selected, and exec.Command inherits
	// it, so it is set for the whole test — one mode per test process is
	// enough because the modes are chosen per test.
	t.Setenv(helperEnv, mode)
	for i := 0; i+1 < len(extraEnv); i += 2 {
		t.Setenv(extraEnv[i], extraEnv[i+1])
	}
	return []string{exe}
}

// syncWriter collects the child's and the supervisor's output; both write to it
// from their own goroutines.
type syncWriter struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (w *syncWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *syncWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// eventually polls until want appears in the log, so a test never depends on a
// fixed sleep being long enough.
func eventually(t *testing.T, log *syncWriter, want string, count int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Count(log.String(), want) >= count {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("waited for %d×%q; log was:\n%s", count, want, log.String())
}

func writeConfig(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

// The behaviour the image exists for: a rendered configuration changes and the
// running gatekeeper is reloaded in place — no restart, no second container
// reaching into this one's PID namespace.
func TestAChangedConfigReloadsTheGatekeeper(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, "version: 1\nendpoints: []\n")

	log := &syncWriter{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan int, 1)
	go func() {
		code, err := sidecar.Run(ctx, sidecar.Options{
			Config:   path,
			Command:  helperCommand(t, "gatekeeper"),
			Interval: 20 * time.Millisecond,
			Stdout:   log, Stderr: log,
		})
		if err != nil {
			t.Errorf("Run: %v", err)
		}
		done <- code
	}()

	eventually(t, log, "gatekeeper: up", 1)

	// An admin edit: new content, so a real change.
	writeConfig(t, path, "version: 1\nendpoints: []\nlog:\n  level: debug\n")
	eventually(t, log, "sending SIGHUP", 1)
	eventually(t, log, "gatekeeper: reloaded", 1)

	// A second, distinct change reloads again — the watcher does not fire once
	// and stop.
	writeConfig(t, path, "version: 1\nendpoints: []\nlog:\n  level: warn\n")
	eventually(t, log, "gatekeeper: reloaded", 2)

	cancel()
	if code := <-done; code != 0 {
		t.Errorf("exit = %d, want 0 after a clean shutdown", code)
	}
	if !strings.Contains(log.String(), "gatekeeper: stopped") {
		t.Errorf("the gatekeeper was not asked to drain:\n%s", log.String())
	}
}

// A control loop that re-renders on every unrelated mutation writes the same
// bytes again. Reloading on that would force a re-attestation of every
// endpoint for nothing, so identical content is not a change.
func TestRewritingIdenticalContentDoesNotReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	const body = "version: 1\nendpoints: []\n"
	writeConfig(t, path, body)

	log := &syncWriter{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		if _, err := sidecar.Run(ctx, sidecar.Options{
			Config:   path,
			Command:  helperCommand(t, "gatekeeper"),
			Interval: 20 * time.Millisecond,
			Stdout:   log, Stderr: log,
		}); err != nil {
			t.Errorf("Run: %v", err)
		}
	}()
	eventually(t, log, "gatekeeper: up", 1)

	// Same bytes, new mtime — several times over, to give a mtime-only watcher
	// every chance to fire.
	for range 3 {
		time.Sleep(30 * time.Millisecond)
		writeConfig(t, path, body)
	}
	time.Sleep(200 * time.Millisecond)

	if strings.Contains(log.String(), "sending SIGHUP") {
		t.Errorf("an identical re-render was treated as a change:\n%s", log.String())
	}

	// And a real change still gets through afterwards, so the suppression is
	// not a watcher that gave up.
	writeConfig(t, path, body+"log:\n  level: debug\n")
	eventually(t, log, "gatekeeper: reloaded", 1)
}

// A sidecar and the container that renders its configuration start in
// parallel. Waiting is the whole difference between that and a crash loop.
func TestItWaitsForTheConfigToBeRendered(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")

	log := &syncWriter{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		if _, err := sidecar.Run(ctx, sidecar.Options{
			Config:   path,
			Command:  helperCommand(t, "gatekeeper"),
			Interval: 20 * time.Millisecond,
			Stdout:   log, Stderr: log,
		}); err != nil {
			t.Errorf("Run: %v", err)
		}
	}()

	eventually(t, log, "waiting for", 1)
	if strings.Contains(log.String(), "gatekeeper: up") {
		t.Fatal("the gatekeeper was started before its configuration existed")
	}

	writeConfig(t, path, "version: 1\nendpoints: []\n")
	eventually(t, log, "gatekeeper: up", 1)
}

// Nothing was ever rendered and the pod is going away: the supervisor has to
// return rather than wait forever, and say what it was waiting for.
func TestItGivesUpWaitingWhenCancelled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	code, err := sidecar.Run(ctx, sidecar.Options{
		Config:   path,
		Command:  helperCommand(t, "gatekeeper"),
		Interval: 20 * time.Millisecond,
		Stdout:   &syncWriter{}, Stderr: &syncWriter{},
	})
	if err == nil {
		t.Fatal("Run returned no error for a configuration that never appeared")
	}
	if !strings.Contains(err.Error(), "never rendered") || !strings.Contains(err.Error(), path) {
		t.Errorf("err = %v, want it to name the file it waited for", err)
	}
	if code == 0 {
		t.Error("exit = 0, want a failure")
	}
}

// The container's exit status has to be the gatekeeper's: a pod's restart
// policy and a `docker run` both branch on it, and a supervisor that flattened
// every failure to 1 would hide a configuration error behind a crash.
func TestTheChildsExitStatusIsReported(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, "version: 1\nendpoints: []\n")

	for _, want := range []int{0, 2, 7} {
		t.Run(strconv.Itoa(want), func(t *testing.T) {
			code, err := sidecar.Run(context.Background(), sidecar.Options{
				Config:   path,
				Command:  helperCommand(t, "exit", helperExit, strconv.Itoa(want)),
				Interval: 20 * time.Millisecond,
				Stdout:   &syncWriter{}, Stderr: &syncWriter{},
			})
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			if code != want {
				t.Errorf("exit = %d, want %d", code, want)
			}
		})
	}
}

// A missing binary is a broken image, not something to retry silently.
func TestAnUnstartableChildIsReported(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, "version: 1\nendpoints: []\n")

	code, err := sidecar.Run(context.Background(), sidecar.Options{
		Config:   path,
		Command:  []string{filepath.Join(t.TempDir(), "not-a-binary")},
		Interval: 20 * time.Millisecond,
		Stdout:   &syncWriter{}, Stderr: &syncWriter{},
	})
	if err == nil {
		t.Fatal("Run accepted a command it could not start")
	}
	if code == 0 {
		t.Error("exit = 0, want a failure")
	}
	if !strings.Contains(err.Error(), "starting") {
		t.Errorf("err = %v, want it to say it could not start the gatekeeper", err)
	}
}

func TestRunRequiresAConfigPath(t *testing.T) {
	if _, err := sidecar.Run(context.Background(), sidecar.Options{}); err == nil {
		t.Fatal("Run accepted an empty configuration path")
	}
}
