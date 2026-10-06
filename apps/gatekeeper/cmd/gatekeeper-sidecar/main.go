// Command gatekeeper-sidecar is the entrypoint of the gatekeeper container
// image: it runs `gatekeeper run --headless` and reloads it when the rendered
// configuration file changes (ADR-008 §5 step 2).
//
// It is not a user-facing command and is not part of a GitHub Release — the
// gatekeeper a person installs is driven by hand, not by a control loop. The
// logic lives in pkg/sidecar; this file only maps flags, signals and the exit
// status onto it.
//
//	gatekeeper-sidecar [--config /etc/gatekeeper/config.yaml] [--interval 2s]
//	                   [-- <command to supervise>...]
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/sidecar"
)

func main() {
	config := flag.String("config", envOr("GATEKEEPER_CONFIG", sidecar.DefaultConfigPath),
		"the gatekeeper configuration file to watch")
	interval := flag.Duration("interval", envDuration("GATEKEEPER_WATCH_INTERVAL", sidecar.DefaultInterval),
		"how often the configuration file is examined")
	grace := flag.Duration("shutdown-grace", sidecar.DefaultShutdownGrace,
		"how long the gatekeeper may take to drain after SIGTERM")
	flag.Parse()

	// SIGHUP is the signal this process *sends*, never one it acts on: an
	// operator who HUPs the container means the gatekeeper, and the default
	// disposition would kill the supervisor instead.
	signal.Ignore(syscall.SIGHUP)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	code, err := sidecar.Run(ctx, sidecar.Options{
		Config:        *config,
		Command:       flag.Args(),
		Interval:      *interval,
		ShutdownGrace: *grace,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	os.Exit(code)
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		// Reported rather than fatal: a typo in a tuning knob must not keep the
		// egress down.
		fmt.Fprintf(os.Stderr, "sidecar: $%s=%q is not a positive duration; using %s\n", name, value, fallback)
		return fallback
	}
	return parsed
}
