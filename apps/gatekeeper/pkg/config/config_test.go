package config_test

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// baseConfig is a minimal valid document; tests append to or edit it.
const baseConfig = `version: 1
trustedRoots:
  - name: swarm-cloud-prod
    pem: |
      -----BEGIN CERTIFICATE-----
      MIIBkTCB+w==
      -----END CERTIFICATE-----
defaults:
  reattestInterval: 10m
  maxBundleAge: 12h
endpoints:
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://llama.tee.swarm.cloud
    trustedEvidence:
      - sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE
    verdictCacheTtl: 30s
  - name: qwen
    listen: 127.0.0.1:8444
    upstream: https://qwen.tee.swarm.cloud
    trustedEvidence:
      - 6b1f0d8c3a2e9f4b7c1d5e6a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c
    failMode: open
`

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing config: %v", err)
	}
	return path
}

func TestLoadResolvesTuningPrecedence(t *testing.T) {
	path := writeConfig(t, baseConfig)

	cfg, err := config.Load(config.Options{Path: path, Environ: []string{}})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	llama, _ := cfg.Endpoint("llama")
	tuning := cfg.Tuning(llama)
	// `defaults:` beats the built-in, the endpoint beats `defaults:`, and
	// anything nobody set keeps the built-in value.
	if got, want := tuning.ReattestInterval, 10*time.Minute; got != want {
		t.Errorf("reattestInterval = %s, want %s (from defaults)", got, want)
	}
	if got, want := tuning.VerdictCacheTTL, 30*time.Second; got != want {
		t.Errorf("verdictCacheTtl = %s, want %s (from the endpoint)", got, want)
	}
	if got, want := tuning.MaxBundleAge, 12*time.Hour; got != want {
		t.Errorf("maxBundleAge = %s, want %s (from defaults)", got, want)
	}
	if got, want := tuning.InitialTimeout, config.DefaultInitialTimeout; got != want {
		t.Errorf("initialTimeout = %s, want the built-in %s", got, want)
	}
	if got, want := tuning.FailMode, config.FailClosed; got != want {
		t.Errorf("failMode = %q, want the built-in %q", got, want)
	}

	qwen, _ := cfg.Endpoint("qwen")
	if got := cfg.Tuning(qwen).FailMode; got != config.FailOpen {
		t.Errorf("qwen failMode = %q, want %q", got, config.FailOpen)
	}
}

func TestLoadEnvOverridesFile(t *testing.T) {
	path := writeConfig(t, baseConfig)

	cfg, err := config.Load(config.Options{
		Path: path,
		Environ: []string{
			"CR_GATEKEEPER_REATTEST_INTERVAL=1m",
			"CR_GATEKEEPER_LOG_LEVEL=debug",
			"CR_GATEKEEPER_METRICS_LISTEN=127.0.0.1:9464",
			"CR_GATEKEEPER_ENDPOINT_LLAMA_VERDICT_CACHE_TTL=5s",
			"CR_GATEKEEPER_ENDPOINT_LLAMA_UPSTREAM=https://staging.tee.swarm.cloud",
			"UNRELATED=1",
		},
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	llama, _ := cfg.Endpoint("llama")
	tuning := cfg.Tuning(llama)
	if got, want := tuning.ReattestInterval, time.Minute; got != want {
		t.Errorf("reattestInterval = %s, want %s (global env beats defaults:)", got, want)
	}
	// The per-endpoint variable is the more specific layer, so it also beats
	// the value the endpoint itself carries in the file.
	if got, want := tuning.VerdictCacheTTL, 5*time.Second; got != want {
		t.Errorf("verdictCacheTtl = %s, want %s (per-endpoint env)", got, want)
	}
	if got, want := llama.Upstream, "https://staging.tee.swarm.cloud"; got != want {
		t.Errorf("upstream = %q, want %q", got, want)
	}
	if got, want := cfg.LogLevel(), "debug"; got != want {
		t.Errorf("log level = %q, want %q", got, want)
	}
	if cfg.Metrics == nil || cfg.Metrics.Listen != "127.0.0.1:9464" {
		t.Errorf("metrics = %+v, want listen 127.0.0.1:9464", cfg.Metrics)
	}
}

func TestLoadFlagsBeatEnv(t *testing.T) {
	path := writeConfig(t, baseConfig)

	fs := flag.NewFlagSet("gatekeeper", flag.ContinueOnError)
	overrides := config.RegisterFlags(fs)
	if err := fs.Parse([]string{"--reattest-interval=2m", "--log-level=warn"}); err != nil {
		t.Fatalf("Parse: %v", err)
	}

	cfg, err := config.Load(config.Options{
		Path:      path,
		Environ:   []string{"CR_GATEKEEPER_REATTEST_INTERVAL=1m", "CR_GATEKEEPER_LOG_LEVEL=debug", "CR_GATEKEEPER_LOG_FORMAT=json"},
		Overrides: overrides(),
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	llama, _ := cfg.Endpoint("llama")
	if got, want := cfg.Tuning(llama).ReattestInterval, 2*time.Minute; got != want {
		t.Errorf("reattestInterval = %s, want %s (flag beats env)", got, want)
	}
	if got, want := cfg.LogLevel(), "warn"; got != want {
		t.Errorf("log level = %q, want %q (flag beats env)", got, want)
	}
	// A flag that was not passed must not shadow the env layer.
	if got, want := cfg.LogFormat(), "json"; got != want {
		t.Errorf("log format = %q, want %q (unset flag keeps env)", got, want)
	}
}

func TestLoadRejectsUnknownEnvOverride(t *testing.T) {
	path := writeConfig(t, baseConfig)

	_, err := config.Load(config.Options{Path: path, Environ: []string{"CR_GATEKEEPER_REATEST_INTERVAL=1m"}})
	if err == nil || !strings.Contains(err.Error(), "unknown gatekeeper environment override") {
		t.Fatalf("err = %v, want an unknown-override error (a typo must not be ignored)", err)
	}

	_, err = config.Load(config.Options{Path: path, Environ: []string{"CR_GATEKEEPER_ENDPOINT_MISTRAL_LISTEN=127.0.0.1:1"}})
	if err == nil || !strings.Contains(err.Error(), `no endpoint named "mistral"`) {
		t.Fatalf("err = %v, want a missing-endpoint error", err)
	}
}

func TestResolvePathPrecedence(t *testing.T) {
	env := []string{"CR_GATEKEEPER_CONFIG=/from/cr", "GATEKEEPER_CONFIG=/from/legacy"}

	if got, want := config.ResolvePath("/from/flag", env), "/from/flag"; got != want {
		t.Errorf("ResolvePath(flag) = %q, want %q", got, want)
	}
	if got, want := config.ResolvePath("", env), "/from/cr"; got != want {
		t.Errorf("ResolvePath(env) = %q, want %q", got, want)
	}
	if got, want := config.ResolvePath("", env[1:]), "/from/legacy"; got != want {
		t.Errorf("ResolvePath(legacy env) = %q, want %q", got, want)
	}
	if got := config.ResolvePath("", nil); !strings.HasSuffix(got, filepath.Join("confidential-gatekeeper", "config.yaml")) {
		t.Errorf("ResolvePath(default) = %q, want the XDG default", got)
	}
}

func TestLoadMissingFile(t *testing.T) {
	_, err := config.Load(config.Options{Path: filepath.Join(t.TempDir(), "absent.yaml"), Environ: []string{}})
	if err == nil || !strings.Contains(err.Error(), "no gatekeeper config file") {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestParseRejectsUnknownField(t *testing.T) {
	_, err := config.Parse(strings.NewReader("version: 1\ntrustedEvidance: []\n"), "config.yaml")
	if err == nil || !strings.Contains(err.Error(), "trustedEvidance") {
		t.Fatalf("err = %v, want the unknown key to be named", err)
	}
}

func TestResolveAnchorsRelativePathsAtTheConfigFile(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{Path: filepath.Join(dir, "config.yaml")}

	if got, want := cfg.Resolve("./roots/staging.pem"), filepath.Join(dir, "roots/staging.pem"); got != want {
		t.Errorf("Resolve = %q, want %q", got, want)
	}
	if got, want := cfg.Resolve("/etc/roots.pem"), "/etc/roots.pem"; got != want {
		t.Errorf("Resolve(absolute) = %q, want it unchanged", got)
	}
}

func TestPEMFileIsReadRelativeToTheConfig(t *testing.T) {
	dir := t.TempDir()
	pemPath := filepath.Join(dir, "root.pem")
	if err := os.WriteFile(pemPath, []byte("-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Path: filepath.Join(dir, "config.yaml")}

	got, err := cfg.PEM(config.TrustedRoot{Name: "staging", PEMFile: "root.pem"})
	if err != nil {
		t.Fatalf("PEM: %v", err)
	}
	if !strings.Contains(string(got), "BEGIN CERTIFICATE") {
		t.Errorf("PEM = %q, want the file contents", got)
	}
}

// unfinishedConfig is the state `gatekeeper endpoint add` leaves behind: a
// well-formed file that is not yet runnable, because the endpoint has no pin.
// Getting it a pin is what `endpoint trust add --from-upstream` is *for*.
const unfinishedConfig = `version: 1
trustedRoots:
  - name: swarm-cloud-prod
    pem: |
      -----BEGIN CERTIFICATE-----
      MIIBkTCB+w==
      -----END CERTIFICATE-----
endpoints:
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://llama.tee.swarm.cloud
    trustedEvidence: []
`

func TestLoadEditableAcceptsAConfigThatIsNotFinishedYet(t *testing.T) {
	path := writeConfig(t, unfinishedConfig)

	// Without Editable this is the strict load every listener does, and it must
	// keep refusing: an endpoint with no pins can never admit anything.
	if _, err := config.Load(config.Options{Path: path, Environ: []string{}}); err == nil {
		t.Fatal("Load accepted a config with an unpinned endpoint")
	}

	// With it, the commands that only *inspect* a live host can run. Requiring a
	// finished config to run them would make the sequence `gatekeeper init`
	// prints impossible to follow: the endpoint gets its first pin from
	// `endpoint trust add --from-upstream`, which needs a verifier, which needs
	// a loaded config. `tools/demo` walks that sequence end to end.
	cfg, err := config.Load(config.Options{Path: path, Environ: []string{}, Editable: true})
	if err != nil {
		t.Fatalf("Load(Editable): %v, want the unfinished file to load", err)
	}
	if len(cfg.Endpoints) != 1 || cfg.Endpoints[0].Name != "llama" {
		t.Fatalf("endpoints = %+v, want the one from the file", cfg.Endpoints)
	}
	if len(cfg.Endpoints[0].TrustedEvidence) != 0 {
		t.Errorf("trustedEvidence = %v, want it left empty", cfg.Endpoints[0].TrustedEvidence)
	}
}

func TestLoadEditableStillRejectsAValueThatIsWrong(t *testing.T) {
	path := writeConfig(t, strings.Replace(unfinishedConfig,
		"listen: 127.0.0.1:8443", "listen: not-an-address", 1))

	// Relaxing "is it finished" must not relax "is it well formed": a typo in a
	// listen address is a mistake at any stage of editing.
	_, err := config.Load(config.Options{Path: path, Environ: []string{}, Editable: true})
	if err == nil {
		t.Fatal("Load(Editable) accepted a malformed listen address")
	}
	if !strings.Contains(err.Error(), "endpoints[0].listen") {
		t.Errorf("err = %v, want it to name the offending field", err)
	}
}
