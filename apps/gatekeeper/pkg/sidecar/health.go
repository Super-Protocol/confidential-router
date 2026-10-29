package sidecar

import (
	"bytes"
	"context"
	"fmt"
	"io"
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
//   - **No configuration the gatekeeper would run.** Healthy. The container is
//     waiting for router-api to render an endpoint, and nothing about restarting
//     it would make that happen sooner.
//   - **A runnable configuration and an admin API that answers.** Healthy, and
//     it reports what the gatekeeper said: how many endpoints are configured,
//     listening and admitting.
//   - **A runnable configuration and an admin API that does not answer.**
//     Unhealthy. This is the state production spent 4.5 days in with
//     `restartCount: 0`, `Ready: true` and nothing watching: the one case where
//     a restart is both the right answer and the only one available.
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
	if why := runnableAt(configPath); why != nil {
		fmt.Fprintf(out, "waiting for %s — %v\n", configPath, why)
		return 0
	}
	body, _, err := readOf(configPath)
	if err != nil {
		// Readable a moment ago and not now: a render in flight. Not a reason to
		// restart anything, and the next probe will see the finished file.
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
	ctx, cancel := context.WithTimeout(ctx, HealthTimeout)
	defer cancel()
	health, err := client.Ping(ctx)
	if err != nil {
		fmt.Fprintf(out, "the gatekeeper's admin API at %s did not answer: %v\n", cfg.Admin.Listen, err)
		return 1
	}
	fmt.Fprintf(out, "ok — %d endpoint(s), %d listening, %d admitting\n",
		health.Endpoints, health.Listening, health.Confidential)
	return 0
}
