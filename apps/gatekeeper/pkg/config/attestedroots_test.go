package config_test

import (
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// TestAttestedRootsDefaults pins what a config that says nothing about the
// anchor gets: it is on, with the built-in registry and cache.
func TestAttestedRootsDefaults(t *testing.T) {
	cfg := mustParse(t, "version: 1\ntrustedRoots: []\nendpoints: []\n")

	if !cfg.AttestedRootsEnabled() {
		t.Error("attested roots are off by default")
	}
	if got, want := cfg.AttestedRootsCacheTTL(), config.DefaultAttestedRootsCacheTTL; got != want {
		t.Errorf("cache TTL = %s, want %s", got, want)
	}
	if got := cfg.AttestedRootsRegistryBaseURL(); got != "" {
		t.Errorf("registry base URL = %q, want the built-in one", got)
	}
	if got, want := cfg.AttestedRootsRequireNetworkType(), config.NetworkTypeAny; got != want {
		t.Errorf("network policy = %q, want %q", got, want)
	}
	if cfg.AttestedRootsCheckRevocations() {
		t.Error("revocation checking is on by default, but it needs the network")
	}
}

// TestAttestedRootsOverrides checks that every knob reaches the resolver.
func TestAttestedRootsOverrides(t *testing.T) {
	cfg := mustParse(t, `version: 1
trustedRoots: []
attestedRoots:
  enabled: false
  registryBaseUrl: https://mirror.internal/signatures
  cacheTtl: 30m
  requireNetworkType: trusted
  checkRevocations: true
endpoints: []
`)

	if cfg.AttestedRootsEnabled() {
		t.Error("enabled: false did not turn the anchor off")
	}
	if got, want := cfg.AttestedRootsCacheTTL(), 30*time.Minute; got != want {
		t.Errorf("cache TTL = %s, want %s", got, want)
	}
	if got, want := cfg.AttestedRootsRegistryBaseURL(), "https://mirror.internal/signatures"; got != want {
		t.Errorf("registry base URL = %q, want %q", got, want)
	}
	if got, want := cfg.AttestedRootsRequireNetworkType(), config.NetworkTypeTrusted; got != want {
		t.Errorf("network policy = %q, want %q", got, want)
	}
	if !cfg.AttestedRootsCheckRevocations() {
		t.Error("checkRevocations: true did not reach the resolver")
	}
}

// TestAttestedRootsTrustedMeasurements is the SUP-139 knob: the operator's own
// pins reach the resolver normalised, whatever spelling the file uses, so the
// verifier compares one form and one form only.
func TestAttestedRootsTrustedMeasurements(t *testing.T) {
	const measurement = "bb6962eb20d616eb0f19479cf7fbccda50ee5682eab75b2104915d305a826aab"
	cfg := mustParse(t, `version: 1
trustedRoots: []
attestedRoots:
  trustedMeasurements:
    - `+measurement+`
    - sha256:BB6962EB20D616EB0F19479CF7FBCCDA50EE5682EAB75B2104915D305A826AAC
endpoints: []
`)

	got := cfg.AttestedRootsTrustedMeasurements()
	want := []string{measurement, measurement[:len(measurement)-1] + "c"}
	if len(got) != len(want) {
		t.Fatalf("measurements = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("measurement %d = %q, want %q", i, got[i], want[i])
		}
	}
}

// TestAttestedRootsWithNoMeasurementsResolvesEmpty keeps the default closed: a
// config that says nothing pins nothing, and must not resolve to a list the
// verifier could match an empty measurement against.
func TestAttestedRootsWithNoMeasurementsResolvesEmpty(t *testing.T) {
	cfg := mustParse(t, "version: 1\ntrustedRoots: []\nendpoints: []\n")
	if got := cfg.AttestedRootsTrustedMeasurements(); len(got) != 0 {
		t.Errorf("measurements = %v, want none", got)
	}
}
