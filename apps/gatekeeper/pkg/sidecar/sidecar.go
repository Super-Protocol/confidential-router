// Package sidecar is the entrypoint of the gatekeeper's container image: it
// supervises one `gatekeeper run --headless` and reloads it when the
// configuration file underneath it changes (ADR-008 §5 step 2).
//
// Why a supervisor exists at all. In the router's attested egress the
// configuration is *rendered* — router-api writes a fresh file into a shared
// volume on boot and on every admin mutation — and the gatekeeper applies a
// changed file on SIGHUP. Nothing in a plain pod sends that signal: the writer
// is in another container, and reaching into this one's PID namespace would
// need `shareProcessNamespace`, which is a privilege the deployment should not
// have to ask for. Watching the file from inside this container needs none of
// it, and leaves the core untouched: the signal path is the same one an
// operator uses by hand.
//
// What it deliberately does not do: restart the gatekeeper. A reload keeps the
// listeners and the connections of every endpoint that did not change
// (pkg/proxy), and a configuration that fails validation changes nothing and
// logs why. Restarting on a bad render would instead take working endpoints
// down.
package sidecar

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// Defaults for the knobs an operator can override. The poll interval is a
// trade between how fast an admin edit takes effect and how often a tiny file
// is stat'ed; two seconds is far below the re-attest interval it feeds, so it
// is never the slow part of applying a change.
const (
	DefaultConfigPath = "/etc/gatekeeper/config.yaml"
	DefaultInterval   = 2 * time.Second
	// DefaultShutdownGrace is how long the gatekeeper gets to drain after
	// SIGTERM before it is killed. Kubernetes' own default grace period is 30s,
	// so this has to be comfortably inside it.
	DefaultShutdownGrace = 10 * time.Second
)

// Options configures [Run].
type Options struct {
	// Config is the gatekeeper configuration file to watch. Required.
	Config string
	// Command is the process to supervise, argv-style. Empty means
	// `gatekeeper run --headless --config <Config>` resolved on PATH, which is
	// what the image's entrypoint wants.
	Command []string
	// Interval is how often Config is examined; zero means [DefaultInterval].
	Interval time.Duration
	// ShutdownGrace bounds the wait after SIGTERM; zero means
	// [DefaultShutdownGrace].
	ShutdownGrace time.Duration
	// Stdout and Stderr receive the child's output and this supervisor's own
	// log lines. Nil means the process's own.
	Stdout, Stderr io.Writer
}

// Run waits for the configuration file to appear, starts the gatekeeper, and
// reloads it whenever the file changes, until the child exits or ctx is
// cancelled. It returns the exit status the container should report.
//
// Waiting for the file rather than failing on a missing one is not politeness:
// a sidecar and the container that renders its configuration start in
// parallel, and a crash loop until the writer wins would be the only
// observable difference.
func Run(ctx context.Context, opts Options) (int, error) {
	if opts.Config == "" {
		return 1, errors.New("sidecar: a configuration file path is required")
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	grace := opts.ShutdownGrace
	if grace <= 0 {
		grace = DefaultShutdownGrace
	}
	stdout, stderr := opts.Stdout, opts.Stderr
	if stdout == nil {
		stdout = os.Stdout
	}
	if stderr == nil {
		stderr = os.Stderr
	}

	if err := waitForConfig(ctx, opts.Config, interval, stderr); err != nil {
		return 1, err
	}

	argv := opts.Command
	if len(argv) == 0 {
		argv = []string{"gatekeeper", "run", "--headless", "--config", opts.Config}
	}
	cmd := exec.Command(argv[0], argv[1:]...) //nolint:gosec // the argv is this image's own entrypoint
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := cmd.Start(); err != nil {
		return 1, fmt.Errorf("sidecar: starting %s: %w", argv[0], err)
	}
	fmt.Fprintf(stderr, "sidecar: started %s (pid %d), watching %s every %s\n",
		argv[0], cmd.Process.Pid, opts.Config, interval)

	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()

	previous, _ := observe(opts.Config)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case err := <-waited:
			return exitCode(err), nil

		case <-ctx.Done():
			// Pass the shutdown on rather than dying first: the gatekeeper
			// closes its listeners itself, and a sidecar that exited would
			// leave the pod reporting this container as the failure.
			fmt.Fprintln(stderr, "sidecar: shutting the gatekeeper down")
			_ = cmd.Process.Signal(syscall.SIGTERM)
			select {
			case err := <-waited:
				return exitCode(err), nil
			case <-time.After(grace):
				fmt.Fprintf(stderr, "sidecar: the gatekeeper did not exit within %s; killing it\n", grace)
				_ = cmd.Process.Kill()
				return exitCode(<-waited), nil
			}

		case <-ticker.C:
			current, err := observe(opts.Config)
			if err != nil {
				// A file that momentarily cannot be read — mid-rename, or
				// briefly absent — is not a reason to signal anything. The
				// next tick sees the finished write.
				continue
			}
			if current.stamp == previous.stamp {
				continue
			}
			unchanged := current.digest == previous.digest
			previous = current
			if unchanged {
				continue
			}
			fmt.Fprintf(stderr, "sidecar: %s changed; sending SIGHUP\n", opts.Config)
			if err := cmd.Process.Signal(syscall.SIGHUP); err != nil {
				fmt.Fprintf(stderr, "sidecar: could not signal the gatekeeper: %v\n", err)
			}
		}
	}
}

// waitForConfig blocks until the configuration file can be read.
func waitForConfig(ctx context.Context, path string, interval time.Duration, log io.Writer) error {
	if _, err := observe(path); err == nil {
		return nil
	}
	fmt.Fprintf(log, "sidecar: waiting for %s to be rendered\n", path)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("sidecar: %s was never rendered: %w", path, ctx.Err())
		case <-ticker.C:
			if _, err := observe(path); err == nil {
				return nil
			}
		}
	}
}

// observation is one look at the configuration file: the stat the design
// watches, and the digest of what it holds.
//
// Two values rather than one, because they answer different questions. The
// stamp — mtime and size — is what moves on every write and is what decides
// whether the file is worth reading at all. The digest is what decides whether
// to reload: a control loop that re-renders on every unrelated mutation writes
// the same bytes again, and treating that as a change would cost a reload and
// a forced re-attestation of every endpoint for nothing.
type observation struct {
	stamp  string
	digest string
}

// observe reads the file's current state. A read error is returned as-is: the
// caller treats "cannot read it right now" as "no news", never as a change.
func observe(path string) (observation, error) {
	info, err := os.Stat(path)
	if err != nil {
		return observation{}, err
	}
	if info.IsDir() {
		return observation{}, fmt.Errorf("%s is a directory", path)
	}
	body, err := os.ReadFile(path) //nolint:gosec // the operator names this file
	if err != nil {
		return observation{}, err
	}
	return observation{
		stamp:  fmt.Sprintf("%d/%d", info.ModTime().UnixNano(), info.Size()),
		digest: fmt.Sprintf("%x", sha256.Sum256(body)),
	}, nil
}

// exitCode maps the child's termination onto the status this process reports,
// so `docker run` and a pod's restart policy see what the gatekeeper decided
// rather than what the supervisor made of it.
func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if code := exit.ExitCode(); code >= 0 {
			return code
		}
		// Killed by a signal: the conventional 128+signo, which is what a
		// shell would have reported.
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal())
		}
	}
	return 1
}
