package cli_test

import (
	"bytes"
	"context"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

var update = flag.Bool("update", false, "rewrite the golden files")

// fixedNow is the clock every test runs at, so "3m ago" is stable output.
var fixedNow = time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)

// result is one CLI invocation's observable behaviour: what a user would see
// and what a script would branch on.
type result struct {
	stdout string
	stderr string
	code   int
}

// harness is a gatekeeper CLI wired to a temp config file, with both runtime
// seams under the test's control.
type harness struct {
	t          *testing.T
	dir        string
	configPath string
	env        cli.Env
	stdin      *bytes.Buffer
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	h := &harness{
		t:          t,
		dir:        dir,
		configPath: filepath.Join(dir, "config.yaml"),
		stdin:      &bytes.Buffer{},
	}
	h.env = cli.Env{
		// The environment is emptied rather than inherited: a developer with
		// $GATEKEEPER_CONFIG set must not change what the tests assert.
		Environ: []string{},
		Now:     func() time.Time { return fixedNow },
	}
	return h
}

// run executes one command line against the harness's config file.
func (h *harness) run(args ...string) result {
	h.t.Helper()
	var stdout, stderr bytes.Buffer
	env := h.env
	env.Stdin = h.stdin
	env.Stdout = &stdout
	env.Stderr = &stderr

	full := append([]string{"--config", h.configPath}, args...)
	code := cli.Run(context.Background(), env, full)
	return result{stdout: h.scrub(stdout.String()), stderr: h.scrub(stderr.String()), code: code}
}

// scrub replaces the temp directory with a stable placeholder so that output
// containing the config path can be compared against a golden file.
func (h *harness) scrub(s string) string {
	return strings.ReplaceAll(s, h.dir, "$TMP")
}

// write puts a file in the harness directory and returns its path.
func (h *harness) write(name, content string) string {
	h.t.Helper()
	path := filepath.Join(h.dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		h.t.Fatalf("writing %s: %v", name, err)
	}
	return path
}

// appendConfig adds YAML to the end of the config file, for the sections no
// command writes.
func (h *harness) appendConfig(yaml string) {
	h.t.Helper()
	f, err := os.OpenFile(h.configPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		h.t.Fatalf("opening config: %v", err)
	}
	defer f.Close() //nolint:errcheck // test helper
	if _, err := f.WriteString(yaml); err != nil {
		h.t.Fatalf("appending to config: %v", err)
	}
}

// config returns the current contents of the config file.
func (h *harness) config() string {
	h.t.Helper()
	data, err := os.ReadFile(h.configPath)
	if err != nil {
		h.t.Fatalf("reading config: %v", err)
	}
	return string(data)
}

// mustRun fails the test unless the command succeeded.
func (h *harness) mustRun(args ...string) result {
	h.t.Helper()
	got := h.run(args...)
	if got.code != cli.ExitOK {
		h.t.Fatalf("gatekeeper %s: exit %d\nstdout:\n%s\nstderr:\n%s",
			strings.Join(args, " "), got.code, got.stdout, got.stderr)
	}
	return got
}

// golden compares output against testdata/<name>.golden, rewriting it under
// -update. Golden files are how the CLI's output gets reviewed as output: a
// table that quietly loses a column is a regression no assertion on substrings
// would catch.
func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name+".golden")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil { //nolint:gosec // test fixture
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading golden file (run `go test ./pkg/cli -update` to create it): %v", err)
	}
	if got != string(want) {
		t.Errorf("output does not match %s\n--- got ---\n%s\n--- want ---\n%s", path, got, want)
	}
}

// fakeVerifier returns a fixed report, and records what it was asked about.
type fakeVerifier struct {
	report   *status.Report
	err      error
	requests []status.VerifyRequest
}

func (f *fakeVerifier) Verify(_ context.Context, req status.VerifyRequest) (*status.Report, error) {
	f.requests = append(f.requests, req)
	if f.err != nil {
		return nil, f.err
	}
	return f.report, nil
}

// fakeSupervisor serves a fixed snapshot.
type fakeSupervisor struct {
	snapshot status.Snapshot
	stopped  []string
}

func (f *fakeSupervisor) Snapshot(context.Context) status.Snapshot { return f.snapshot }

func (f *fakeSupervisor) Events(ctx context.Context) <-chan status.Event {
	out := make(chan status.Event)
	go func() {
		<-ctx.Done()
		close(out)
	}()
	return out
}

func (f *fakeSupervisor) Start(context.Context, string) error { return nil }

func (f *fakeSupervisor) Stop(_ context.Context, endpoint string) error {
	f.stopped = append(f.stopped, endpoint)
	return nil
}

func (f *fakeSupervisor) Reattest(context.Context, string) (*status.Report, error) {
	return nil, nil
}

// runCtx is [harness.run] under a caller-supplied context, for the commands
// that block until they are told to stop.
func (h *harness) runCtx(ctx context.Context, args ...string) result {
	h.t.Helper()
	var stdout, stderr bytes.Buffer
	env := h.env
	env.Stdin = h.stdin
	env.Stdout = &stdout
	env.Stderr = &stderr

	full := append([]string{"--config", h.configPath}, args...)
	code := cli.Run(ctx, env, full)
	return result{stdout: h.scrub(stdout.String()), stderr: h.scrub(stderr.String()), code: code}
}
