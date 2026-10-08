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
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
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

// Run waits for a configuration the gatekeeper can run, starts it, and reloads
// it whenever the file changes, until the child exits or ctx is cancelled. It
// returns the exit status the container should report.
//
// Waiting rather than failing is not politeness: a sidecar and the container
// that renders its configuration start in parallel, and a crash loop until the
// writer wins would be the only observable difference.
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

	w := &watcher{path: opts.Config}
	w.start()
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
			reload, why := w.changed()
			if why != nil {
				fmt.Fprintf(stderr, "sidecar: %s is not a configuration yet; not reloading — %v\n",
					opts.Config, why)
			}
			if !reload {
				continue
			}
			fmt.Fprintf(stderr, "sidecar: %s changed; sending SIGHUP\n", opts.Config)
			if err := cmd.Process.Signal(syscall.SIGHUP); err != nil {
				fmt.Fprintf(stderr, "sidecar: could not signal the gatekeeper: %v\n", err)
			}
		}
	}
}

// waitForConfig blocks until the file holds a configuration the gatekeeper will
// run, logging each distinct reason it will not, once.
//
// Readable is deliberately not enough, and the difference is a crash loop.
// router-api renders this file out of its database (ADR-008 §5), so on a
// deployment where no external endpoint has been registered — the state every
// deployment ships in — the first render is a perfectly valid document with an
// empty `endpoints` list, which `gatekeeper run` refuses: for a person, a
// configuration with nothing in it is a mistake. Starting the gatekeeper on it
// would have it exit at once, and this supervisor deliberately does not restart
// it (see the package comment), so the container would back off and take the
// pod's readiness with it — with no external endpoint configured, which is not
// a fault at all. Waiting is the same answer this function already gives a file
// that has not appeared yet: the egress has nothing to carry until an endpoint
// exists, and the render that adds one is the signal to start.
func waitForConfig(ctx context.Context, path string, interval time.Duration, log io.Writer) error {
	reported := ""
	ready := func() bool {
		why := runnableAt(path)
		if why == nil {
			return true
		}
		if message := why.Error(); message != reported {
			reported = message
			fmt.Fprintf(log, "sidecar: waiting for %s — %s\n", path, message)
		}
		return false
	}

	if ready() {
		return nil
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("sidecar: %s was never rendered as a configuration the gatekeeper can run: %w",
				path, ctx.Err())
		case <-ticker.C:
			if ready() {
				return nil
			}
		}
	}
}

// runnableAt reports why the gatekeeper would refuse the configuration at path,
// or nil when it would accept it. It applies the full [config.Config.Validate],
// which is exactly the check `gatekeeper run` makes a moment later.
func runnableAt(path string) error {
	body, _, err := readOf(path)
	if err != nil {
		return err
	}
	cfg, err := config.Parse(bytes.NewReader(body), path)
	if err != nil {
		return err
	}
	return cfg.Validate()
}

// watcher decides, once per tick, whether the configuration the gatekeeper is
// running has been replaced by different configuration worth reloading.
//
// Two things it refuses to act on, both of them normal here:
//
//   - **Identical bytes.** A control loop that re-renders the file on every
//     unrelated mutation is the expected caller, and reloading for that would
//     force a re-attestation of every endpoint for nothing. The comparison is
//     therefore against the content the process was *given*, not against the
//     previous tick.
//   - **A render that does not load.** `os.WriteFile` and every naive renderer
//     truncate before they write, so the file is briefly observable as empty or
//     half-written. The gatekeeper would refuse such a reload itself and keep
//     running — correctly — but it would be a wasted signal and an error in its
//     log for something that is not an operator's problem. Parsing the bytes
//     first is exactly the check the gatekeeper would have made, one step
//     earlier, and it needs no timing heuristic.
//
// A renderer that writes to a temporary file and renames is never observed
// mid-write at all, and is still the right way to drive this. Not depending on
// it is cheap.
type watcher struct {
	path string
	// stamp is the mtime and size the file had when its contents were last
	// read. It is the cheap gate: unchanged means there is nothing to hash.
	stamp string
	// applied is the digest of the content the gatekeeper was given.
	applied string
	// rejected is the digest of the last render that would not load, so a
	// broken file is reported once rather than on every tick.
	rejected string
}

// start records the configuration the gatekeeper is about to be given.
func (w *watcher) start() {
	w.stamp, _ = stampOf(w.path)
	_, w.applied, _ = readOf(w.path)
}

// changed reports whether the file now holds loadable configuration that
// differs from what the gatekeeper is running, recording it as applied when it
// does. A render that will not load is returned as why — once per distinct
// broken render — and is never applied.
func (w *watcher) changed() (bool, error) {
	stamp, err := stampOf(w.path)
	if err != nil || stamp == w.stamp {
		// Briefly absent or unreadable is no news, not a change; an unmoved
		// stamp means there is nothing new to read.
		return false, nil
	}
	body, digest, err := readOf(w.path)
	if err != nil {
		// The stat succeeded and the read did not. w.stamp is left alone so the
		// next tick looks again rather than skipping this version.
		return false, nil
	}
	w.stamp = stamp
	if digest == w.applied {
		return false, nil
	}
	if err := loadable(body, w.path); err != nil {
		if digest == w.rejected {
			return false, nil
		}
		w.rejected = digest
		return false, err
	}
	w.applied, w.rejected = digest, ""
	return true, nil
}

// loadable reports whether these bytes are a gatekeeper configuration at all.
//
// Editable rather than full validation on purpose: whether a configuration is
// complete enough to *run* is the gatekeeper's decision, and it makes it on
// reload with the right behaviour already (keep the running configuration, log
// why). All this has to rule out is a file that is not YAML, or not a config.
func loadable(body []byte, path string) error {
	cfg, err := config.Parse(bytes.NewReader(body), path)
	if err != nil {
		return err
	}
	return cfg.ValidateEditable()
}

// stampOf is the cheap half of a look: the file's mtime and size, which move on
// every write.
func stampOf(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a directory", path)
	}
	return fmt.Sprintf("%d/%d", info.ModTime().UnixNano(), info.Size()), nil
}

// readOf returns the file's contents and their digest. The bytes come back with
// the digest so that what is validated and what is fingerprinted are the same
// read — re-opening the file would race the writer.
func readOf(path string) ([]byte, string, error) {
	body, err := os.ReadFile(path) //nolint:gosec // the operator names this file
	if err != nil {
		return nil, "", err
	}
	return body, fmt.Sprintf("%x", sha256.Sum256(body)), nil
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
