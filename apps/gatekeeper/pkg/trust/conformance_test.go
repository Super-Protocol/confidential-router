package trust_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// sharedFixturesDir is the language-neutral vector set, relative to the
// repository root.
const sharedFixturesDir = "libs/attestation-fixtures/vectors"

type digestVectors struct {
	CanonicalFinalCharacters string `json:"canonicalFinalCharacters"`
	Cases                    []struct {
		Input     string `json:"input"`
		Valid     bool   `json:"valid"`
		Canonical string `json:"canonical"`
		Note      string `json:"note"`
	} `json:"cases"`
}

// TestConformanceParseDigest holds the config-file front door to the same
// vectors as pkg/attestation's TestConformanceEvidenceDigest. Both run the same
// parser, and this test is what keeps it that way: a pin that loads here has to
// be one the TypeScript tooling also accepts, or the two sides of the product
// disagree about which endpoint a user trusts.
func TestConformanceParseDigest(t *testing.T) {
	t.Parallel()
	vectors := readDigestVectors(t)

	for _, c := range vectors.Cases {
		t.Run(c.Note, func(t *testing.T) {
			t.Parallel()
			got, err := trust.ParseDigest(c.Input)
			if !c.Valid {
				if err == nil {
					t.Fatalf("ParseDigest(%q) = %q, want a rejection (%s)", c.Input, got, c.Note)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseDigest(%q): %v (%s)", c.Input, err, c.Note)
			}
			if got.String() != c.Canonical {
				t.Fatalf("ParseDigest(%q) = %q, want %q", c.Input, got, c.Canonical)
			}
		})
	}
}

// TestConformanceParseDigestFinalCharacters walks the whole base64url alphabet
// in the final position and checks the parser accepts exactly the set the
// vectors publish. A digest is 32 bytes, so the last sextet has two spare bits:
// only the 16 characters that leave them zero are a canonical spelling, and
// accepting any of the other 48 would make two different-looking pins denote
// the same bytes.
func TestConformanceParseDigestFinalCharacters(t *testing.T) {
	t.Parallel()
	want := readDigestVectors(t).CanonicalFinalCharacters
	if want == "" {
		t.Skip("vectors do not publish canonicalFinalCharacters")
	}
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

	canonical := trust.MustParseDigest(strings.Repeat("ab", 32))
	prefix := strings.TrimPrefix(canonical.String(), trust.Prefix)
	prefix = prefix[:len(prefix)-1]

	var accepted strings.Builder
	for i := range len(alphabet) {
		if _, err := trust.ParseDigest(trust.Prefix + prefix + string(alphabet[i])); err == nil {
			accepted.WriteByte(alphabet[i])
		}
	}
	if accepted.String() != want {
		t.Fatalf("accepted final characters %q, vectors say %q", accepted.String(), want)
	}
}

// TestParseDigestAcceptsThePrefixedHexSugar documents the one spelling accepted
// on top of the vectors — and the one everything user-facing prints, so it is
// also the spelling a user is most likely to paste. Hex is unambiguous without
// a scheme, so `sha256:<hex>` cannot collide with anything; `sha256:<base64url>`
// is a bare token behind a scheme and stays rejected.
func TestParseDigestAcceptsThePrefixedHexSugar(t *testing.T) {
	t.Parallel()
	const (
		hexForm   = "c1e31dc829f754d528b15d0cc5fe8fd43f225865d5c9367f77ee6f116e10f6ab"
		canonical = "sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs"
	)
	got, err := trust.ParseDigest("sha256:" + hexForm)
	if err != nil {
		t.Fatalf("ParseDigest(sha256:<hex>): %v", err)
	}
	if got.String() != canonical {
		t.Errorf("ParseDigest(sha256:<hex>) = %q, want %q", got, canonical)
	}
	if got, err := trust.ParseDigest("sha256:weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs"); err == nil {
		t.Errorf("ParseDigest(sha256:<base64url>) = %q, want a rejection", got)
	}
}

// TestConformanceDisplayFormIsTheHexSpelling holds the *human-facing* half of
// the contract to the same vectors: whatever spelling a digest arrives in, the
// form the CLI prints, the dashboard shows, the config file records and the
// router console copies is `sha256:<hex>` of the same 32 bytes — and pasting
// that form back in yields the canonical digest it came from (SUP-115).
//
// The TypeScript side asserts the identical property over these vectors
// (libs/types/src/evidence-digest.spec.ts), which is what makes "the console
// and the gatekeeper show the same string" a tested claim rather than a hope.
func TestConformanceDisplayFormIsTheHexSpelling(t *testing.T) {
	t.Parallel()
	vectors := readDigestVectors(t)

	for _, c := range vectors.Cases {
		if !c.Valid {
			continue
		}
		t.Run(c.Note, func(t *testing.T) {
			t.Parallel()
			digest, err := trust.ParseDigest(c.Input)
			if err != nil {
				t.Fatalf("ParseDigest(%q): %v", c.Input, err)
			}
			shown := digest.Display()
			if want := "sha256:" + digest.Hex(); shown != want {
				t.Fatalf("Display() = %q, want %q", shown, want)
			}
			if len(digest.Hex()) != 64 || strings.ToLower(digest.Hex()) != digest.Hex() {
				t.Fatalf("Hex() = %q, want 64 lower-case hex characters", digest.Hex())
			}
			// The printed form is itself an accepted input: what a user copies
			// out of a report is what they can paste into `trust add`.
			back, err := trust.ParseDigest(shown)
			if err != nil {
				t.Fatalf("ParseDigest(%q): %v", shown, err)
			}
			if back.String() != c.Canonical {
				t.Fatalf("ParseDigest(%q) = %q, want %q", shown, back, c.Canonical)
			}
		})
	}
}

func readDigestVectors(t *testing.T) digestVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(sharedFixtures(t), "evidence-digest.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vectors digestVectors
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(vectors.Cases) == 0 {
		t.Fatal("the digest vectors are empty")
	}
	return vectors
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
