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

// writeConfigAtomic is the renderer shape the design recommends: a temporary
// file and a rename, so the configuration is never observable half-written and
// exactly one version of it exists at a time.
func writeConfigAtomic(t *testing.T, path, body string) {
	t.Helper()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(body), 0o600); err != nil {
		t.Fatalf("writing %s: %v", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatalf("renaming %s: %v", tmp, err)
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

	// Same bytes, new mtime — several times over, including through a
	// truncate-then-write that is briefly observable as an empty file, to give
	// a watcher that compares anything but the settled contents every chance to
	// fire.
	for range 3 {
		time.Sleep(30 * time.Millisecond)
		writeConfig(t, path, body)
	}
	writeTruncated(t, path, body, 80*time.Millisecond)
	time.Sleep(300 * time.Millisecond)

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

// writeTruncated reproduces what `os.WriteFile` and every naive renderer do:
// truncate, then write. Between the two the file is observably empty, and a
// watcher that acted on the first sighting would SIGHUP the gatekeeper with a
// configuration that cannot parse and then SIGHUP it again with the real one.
func writeTruncated(t *testing.T, path, body string, gap time.Duration) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatalf("truncating %s: %v", path, err)
	}
	time.Sleep(gap)
	if _, err := f.WriteString(body); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("closing %s: %v", path, err)
	}
}

// One reload for one edit, even when the edit is visible in two steps.
func TestAHalfWrittenFileIsNotReloadedTwice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, "version: 1\nendpoints: []\n")

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

	// The empty window is several ticks wide, so the watcher certainly observes
	// it; it still must not act on it.
	writeTruncated(t, path, "version: 1\nendpoints: []\nlog:\n  level: debug\n", 120*time.Millisecond)
	eventually(t, log, "gatekeeper: reloaded", 1)

	// Give any second reload time to show up, then insist there was none.
	time.Sleep(300 * time.Millisecond)
	if got := strings.Count(log.String(), "gatekeeper: reloaded"); got != 1 {
		t.Errorf("one edit produced %d reloads; log was:\n%s", got, log.String())
	}
}

// A render that is not a configuration is reported and not forwarded: the
// gatekeeper would refuse it anyway, so signalling would only put an error in
// its log for something that is not an operator's problem. Reported once, not
// on every tick.
func TestAnUnloadableRenderIsReportedAndNotForwarded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeConfig(t, path, "version: 1\nendpoints: []\n")

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

	// Rendered atomically, so there is exactly one broken version to report —
	// a truncating writer would legitimately produce two (an empty file, then
	// the malformed one), each reported once.
	writeConfigAtomic(t, path, "version: 1\nendpoints: [this is not: a list of endpoints\n")
	eventually(t, log, "is not a configuration yet", 1)
	time.Sleep(200 * time.Millisecond)
	if strings.Contains(log.String(), "sending SIGHUP") {
		t.Errorf("a render that does not load was forwarded to the gatekeeper:\n%s", log.String())
	}
	if got := strings.Count(log.String(), "is not a configuration yet"); got != 1 {
		t.Errorf("one broken render was reported %d times, want once:\n%s", got, log.String())
	}

	// Fixing it still works: the watcher did not get stuck on the bad version.
	writeConfigAtomic(t, path, "version: 1\nendpoints: []\nlog:\n  level: debug\n")
	eventually(t, log, "gatekeeper: reloaded", 1)
}
