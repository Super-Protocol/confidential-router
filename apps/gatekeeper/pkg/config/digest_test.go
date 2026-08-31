package config_test

import (
	"encoding/json"
	"os"
	"path/filepath"
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
