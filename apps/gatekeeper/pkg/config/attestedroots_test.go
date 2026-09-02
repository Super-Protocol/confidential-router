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
