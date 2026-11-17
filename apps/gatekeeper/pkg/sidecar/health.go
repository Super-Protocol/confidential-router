package sidecar

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"syscall"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/proxy"
)

// HealthTimeout bounds one health check. The admin API only renders state
// already in memory, so anything slower is a gatekeeper that is not answering —
// which is the whole of what this check is for.
const HealthTimeout = 5 * time.Second

// Healthcheck answers "should this container be restarted?" from outside the
// supervisor, and is the probe the pod has been missing (SUP-583).
//
// It exists because the obvious probe is wrong. An `httpGet` on `admin.listen`
// would be a liveness check that fails on the state every deployment ships in:
// with no external endpoint registered the rendered configuration has an empty
// `endpoints` list, [waitForConfig] waits — correctly, see its comment — and
// there is no admin listener to probe at all. A probe like that would restart a
// container that is doing the only thing it can, for ever. The listeners are
// also loopback-only by construction, so a kubelet could not reach them without
// the sidecar growing a listener on the pod IP, which is a reachability ADR-008
// deliberately does not grant it.
//
// So the check runs *inside* the container, as an `exec` probe, and derives the
// same three states the supervisor is in from the two things it can see — the
// rendered file and loopback:
//
//   - **Nothing bound, and no configuration the gatekeeper would run.** Healthy.
//     The container is waiting for router-api to render an endpoint, and nothing
//     about restarting it would make that happen sooner.
//   - **An admin API that answers.** Healthy, and it reports what the gatekeeper
//     said: how many endpoints are configured, listening and admitting.
//   - **An admin API that is bound and does not answer** — a timeout, a reset, a
//     non-200 — **or nothing bound where a runnable configuration says there
//     should be.** Unhealthy. The first is the state production spent 4.5 days in
//     with `restartCount: 0`, `Ready: true` and nothing watching: the one case
//     where a restart is both the right answer and the only one available.
//
// Note what it does *not* fail on: a verdict. An endpoint that is denied, or
// fail-closed, or awaiting an admin's approval is an endpoint this gatekeeper is
// refusing on purpose, and restarting the container would re-run exactly the
// same refusal — while dropping every working endpoint beside it. "Is it
// serving?" is a question for the console; this answers "is it answering?".
//
// @returns the exit status the probe should report: 0 healthy, 1 not.
func Healthcheck(ctx context.Context, configPath string, out io.Writer) int {
	if configPath == "" {
		fmt.Fprintln(out, "sidecar: a configuration file path is required")
		return 1
	}
	body, _, err := readOf(configPath)
	if err != nil {
		// Not there yet, or a render in flight: `os.WriteFile` truncates before it
		// writes. Nothing to restart, and the next probe sees the finished file.
		fmt.Fprintf(out, "waiting for %s — %v\n", configPath, err)
		return 0
	}
	cfg, err := config.Parse(bytes.NewReader(body), configPath)
	if err != nil {
		fmt.Fprintf(out, "waiting for %s — %v\n", configPath, err)
		return 0
	}
	if cfg.Admin == nil {
		// Nothing to ask. A configuration with no admin listener is a gatekeeper
		// that was never meant to be readable, not one that has stopped
		// answering, and inventing a failure here would restart it on a setting.
		fmt.Fprintln(out, "no admin listener is configured; nothing to check")
		return 0
	}

	client, err := proxy.NewClient(cfg.Admin.Listen)
	if err != nil {
		fmt.Fprintf(out, "%v\n", err)
		return 1
	}
	pingCtx, cancel := context.WithTimeout(ctx, HealthTimeout)
	defer cancel()
	health, err := client.Ping(pingCtx)
	if err == nil {
		fmt.Fprintf(out, "ok — %d endpoint(s), %d listening, %d admitting\n",
			health.Endpoints, health.Listening, health.Confidential)
		return 0
	}

	// Nothing answered. Which of the two states that is turns on *how* the dial
	// failed, not on what the file says — and getting this wrong either way is a
	// restart loop or a probe that never fires.
	//
	// A refusal (or a missing socket) means nothing is bound. That is the normal
	// state before [Run] has started the gatekeeper, and whether it has is
	// exactly what [runnableAt] answers: the supervisor waits for a
	// configuration the gatekeeper would *run*, which is stricter than one it
	// would parse. So a refusal on a configuration that is not runnable is a
	// container still waiting, and healthy.
	//
	// Anything else — a timeout, a reset, a non-200 — means something is bound
	// and not answering, and the file is not consulted at all. That matters more
	// than it looks: the watcher reloads on `ValidateEditable`, so a deployment
	// whose last endpoint an admin removes keeps a *running* gatekeeper on an
	// `endpoints: []` document that `runnableAt` calls unrunnable. Deciding this
	// case from the file would report healthy for ever on exactly the wedge
	// SUP-583 is about.
	if notListening(err) {
		if why := runnableAt(configPath); why != nil {
			fmt.Fprintf(out, "waiting for %s — %v\n", configPath, why)
			return 0
		}
		fmt.Fprintf(out, "the gatekeeper should be listening on %s and nothing is: %v\n", cfg.Admin.Listen, err)
		return 1
	}
	fmt.Fprintf(out, "the gatekeeper's admin API at %s did not answer: %v\n", cfg.Admin.Listen, err)
	return 1
}

// notListening reports whether the dial found nothing bound, as against a
// listener that would not answer. ENOENT is the unix-socket spelling of the
// same thing.
func notListening(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ENOENT)
}
