package config_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// sharedFixturesDir is the language-neutral vector set, relative to the
// repository root.
const sharedFixturesDir = "libs/attestation-fixtures/vectors"

// TestConformanceParseEvidenceDigest holds config validation to the same
// vectors as the verifier. Before this delegation the two disagreed, and a pin
// the Go config accepted was one the TypeScript tooling rejected.
func TestConformanceParseEvidenceDigest(t *testing.T) {
	t.Parallel()
	var vectors struct {
		Cases []struct {
			Input     string `json:"input"`
			Valid     bool   `json:"valid"`
			Canonical string `json:"canonical"`
			Note      string `json:"note"`
		} `json:"cases"`
	}
	raw, err := os.ReadFile(filepath.Join(sharedFixtures(t), "evidence-digest.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(vectors.Cases) == 0 {
		t.Fatal("the digest vectors are empty")
	}

	for _, c := range vectors.Cases {
		t.Run(c.Note, func(t *testing.T) {
			t.Parallel()
			got, err := config.ParseEvidenceDigest(c.Input)
			if !c.Valid {
				if err == nil {
					t.Fatalf("ParseEvidenceDigest(%q) = %q, want a rejection (%s)", c.Input, got, c.Note)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseEvidenceDigest(%q): %v (%s)", c.Input, err, c.Note)
			}
			if got != c.Canonical {
				t.Fatalf("ParseEvidenceDigest(%q) = %q, want %q", c.Input, got, c.Canonical)
			}
		})
	}
}

// TestParseEvidenceDigestAcceptsThePrefixedHexSugar documents the one spelling
// a config file accepts on top of the vectors: hex behind the `sha256:` scheme
// registries print. A bare base64url token behind the same scheme stays
// rejected — that is the ambiguity the sugar must not open up.
func TestParseEvidenceDigestAcceptsThePrefixedHexSugar(t *testing.T) {
	t.Parallel()
	const (
		hexForm   = "c1e31dc829f754d528b15d0cc5fe8fd43f225865d5c9367f77ee6f116e10f6ab"
		canonical = "sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs"
	)
	got, err := config.ParseEvidenceDigest("sha256:" + hexForm)
	if err != nil {
		t.Fatalf("ParseEvidenceDigest(sha256:<hex>): %v", err)
	}
	if got != canonical {
		t.Errorf("ParseEvidenceDigest(sha256:<hex>) = %q, want %q", got, canonical)
	}
	if got, err := config.ParseEvidenceDigest("sha256:weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs"); err == nil {
		t.Errorf("ParseEvidenceDigest(sha256:<base64url>) = %q, want a rejection", got)
	}
}

// TestValidateRejectsANonCanonicalPin is the same rule at the surface a user
// meets: a spelling the vectors reject must fail `config validate`, not fail
// later when the trust store is built.
func TestValidateRejectsANonCanonicalPin(t *testing.T) {
	t.Parallel()
	for _, pin := range []string{
		// A final character carrying non-zero trailing bits: a second spelling
		// of the same 32 bytes, so a pin that would never match.
		"sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qB",
		// Bare base64url: unlike hex, it is not recognisable without a scheme.
		"weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs",
	} {
		if config.IsEvidenceDigest(pin) {
			t.Errorf("IsEvidenceDigest(%q) = true, want false", pin)
		}
	}
	if !config.IsEvidenceDigest("sha256/c1e31dc829f754d528b15d0cc5fe8fd43f225865d5c9367f77ee6f116e10f6ab") {
		t.Error("sha256/<hex> is in the vectors and must validate")
	}
}

// sharedFixtures walks up from the test's working directory to the repository
// root, so the suite works from a worktree, a plain checkout or CI alike.
func sharedFixtures(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		candidate := filepath.Join(dir, filepath.FromSlash(sharedFixturesDir))
		if info, err := os.Stat(filepath.Join(candidate, "manifest.json")); err == nil && !info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("could not find %s above %s", sharedFixturesDir, dir)
		}
		dir = parent
	}
}

// oneEndpointConfig is a single endpoint whose trustedEvidence is spelled by
// the caller, so a test can make exactly one shape wrong.
func oneEndpointConfig(trustedEvidence string) string {
	return `version: 1
trustedRoots: []
endpoints:
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://llama.tee.swarm.cloud
    trustedEvidence: ` + trustedEvidence + "\n"
}

// TestTrustedEvidenceShapeErrorsNameTheShape covers the message a user gets for
// writing a pin the wrong way round. yaml.v3's own "cannot unmarshal !!str into
// []string" names a Go type nobody typed; the file is what they have to edit.
func TestTrustedEvidenceShapeErrorsNameTheShape(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		value string
		want  string
		// line is where the offending node sits in oneEndpointConfig.
		line string
	}{
		{"one pin without the list", "sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE", "got a string", "line 7"},
		{"a mapping", "{sha256: axNB}", "got a mapping", "line 7"},
		{"a number", "12345", "got a number", "line 7"},
		{"a nested list", "\n      - - sha256/axNB", "item 0 is a list", "line 8"},
		{"an empty item", "\n      -", "item 0 is empty", "line 8"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := config.Load(config.Options{Path: writeConfig(t, oneEndpointConfig(tc.value))})
			if err == nil {
				t.Fatal("Load accepted a trustedEvidence that is not a list of digests")
			}
			message := err.Error()
			if !strings.Contains(message, "must be a list of digest strings") {
				t.Errorf("error = %q, want it to say what a pin list is", message)
			}
			if !strings.Contains(message, tc.want) {
				t.Errorf("error = %q, want it to name the shape it found (%q)", message, tc.want)
			}
			// The line is what turns the message into an edit.
			if !strings.Contains(message, tc.line) {
				t.Errorf("error = %q, want the offending line", message)
			}
		})
	}
}

// TestTrustedEvidenceAcceptsTheShapesThatAreRight guards the other side: an
// absent, null or empty list is a pin-less endpoint, which is a legal file.
func TestTrustedEvidenceAcceptsTheShapesThatAreRight(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ name, value string }{
		{"an empty flow list", "[]"},
		{"an explicit null", "null"},
		{"a block list", "\n      - sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			// Editable, because a pin-less endpoint is exactly what `endpoint
			// add` writes: the shape is right, the file is unfinished.
			cfg, err := config.Load(config.Options{
				Path: writeConfig(t, oneEndpointConfig(tc.value)), Editable: true,
			})
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if len(cfg.Endpoints) != 1 {
				t.Fatalf("endpoints = %d, want 1", len(cfg.Endpoints))
			}
		})
	}
}

// TestTrustedEvidenceResolvesAnAnchor keeps a shared pin list working: it
// arrives as an alias node, which a naive shape check would reject.
func TestTrustedEvidenceResolvesAnAnchor(t *testing.T) {
	t.Parallel()
	body := `version: 1
trustedRoots: []
endpoints:
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://llama.tee.swarm.cloud
    trustedEvidence: &shared
      - sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE
  - name: qwen
    listen: 127.0.0.1:8444
    upstream: https://qwen.tee.swarm.cloud
    trustedEvidence: *shared
`
	cfg, err := config.Load(config.Options{Path: writeConfig(t, body), Editable: true})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.Endpoints[1].TrustedEvidence) != 1 {
		t.Errorf("qwen trustedEvidence = %v, want the anchored pin", cfg.Endpoints[1].TrustedEvidence)
	}
}
