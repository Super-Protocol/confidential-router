package attestation_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
)

// The shared conformance vectors. They are the contract: every implementation
// of the /.well-known/swarm-evidence verifier — the TypeScript one in
// libs/attestation and this package — must reach the same verdict on every
// case. Only `stage` and `reasonContains` are normative on a denial; full reason
// wording is allowed to differ.
//
// The vectors live outside this module, so they are read from disk rather than
// embedded: go:embed cannot reach above the package directory.
const sharedFixturesDir = "libs/attestation-fixtures/vectors"

type conformanceManifest struct {
	Version      string            `json:"version"`
	Description  string            `json:"description"`
	ReferenceNow string            `json:"referenceNow"`
	RootsFile    string            `json:"rootsFile"`
	Cases        []conformanceCase `json:"cases"`
}

type conformanceCase struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Request     struct {
		Hostname               string   `json:"hostname"`
		TrustedRoots           []string `json:"trustedRoots"`
		ObservedTLSFingerprint *string  `json:"observedTlsFingerprint"`
		Now                    string   `json:"now"`
		MaxBundleAge           *int64   `json:"maxBundleAge"`
	} `json:"request"`
	Response struct {
		Status   int    `json:"status"`
		BodyFile string `json:"bodyFile"`
		BodyText string `json:"bodyText"`
	} `json:"response"`
	Expect struct {
		OK             bool            `json:"ok"`
		Kind           string          `json:"kind"`
		Payload        json.RawMessage `json:"payload"`
		ChannelBinding string          `json:"channelBinding"`
		MatchedRoot    string          `json:"matchedRoot"`
		RootCaTeeQuote json.RawMessage `json:"rootCaTeeQuote"`
		Stage          string          `json:"stage"`
		ReasonContains string          `json:"reasonContains"`
	} `json:"expect"`
}

type conformanceRoots struct {
	Roots []struct {
		Name        string `json:"name"`
		Fingerprint string `json:"fingerprint"`
		PEM         string `json:"pem"`
	} `json:"roots"`
}

type digestVectors struct {
	CanonicalFinalCharacters string `json:"canonicalFinalCharacters"`
	Cases                    []struct {
		Input     string `json:"input"`
		Valid     bool   `json:"valid"`
		Canonical string `json:"canonical"`
		Note      string `json:"note"`
	} `json:"cases"`
}

func TestConformance(t *testing.T) {
	t.Parallel()
	dir := sharedFixtures(t)
	manifest := readJSON[conformanceManifest](t, filepath.Join(dir, "manifest.json"))
	roots := readJSON[conformanceRoots](t, filepath.Join(dir, manifest.RootsFile))

	trustedRoots := map[string]attestation.TrustedRoot{}
	for _, root := range roots.Roots {
		trustedRoots[root.Name] = attestation.TrustedRoot{Name: root.Name, PEM: root.PEM}

		// The trust store matches on the fingerprint of the root's DER, so the
		// value the vectors publish must be the one this verifier computes.
		fingerprint, err := attestation.RootFingerprintFromPEM(root.PEM)
		if err != nil {
			t.Fatalf("parse trusted root %q: %v", root.Name, err)
		}
		if fingerprint != root.Fingerprint {
			t.Errorf("root %q: fingerprint = %q, vectors say %q", root.Name, fingerprint, root.Fingerprint)
		}
	}

	for _, testCase := range manifest.Cases {
		t.Run(testCase.ID, func(t *testing.T) {
			t.Parallel()
			runConformanceCase(t, dir, testCase, trustedRoots)
		})
	}
}

func runConformanceCase(t *testing.T, dir string, c conformanceCase, roots map[string]attestation.TrustedRoot) {
	t.Helper()

	now, err := time.Parse(time.RFC3339, c.Request.Now)
	if err != nil {
		t.Fatalf("parse now %q: %v", c.Request.Now, err)
	}
	params := attestation.Params{
		Hostname: c.Request.Hostname,
		Now:      now,
		Fetcher:  caseFetcher(t, dir, c),
	}
	for _, name := range c.Request.TrustedRoots {
		root, ok := roots[name]
		if !ok {
			t.Fatalf("case references unknown trusted root %q", name)
		}
		params.TrustedRoots = append(params.TrustedRoots, root)
	}
	if c.Request.ObservedTLSFingerprint != nil {
		params.ObservedTLSFingerprint = *c.Request.ObservedTLSFingerprint
	}
	if c.Request.MaxBundleAge != nil {
		params.MaxBundleAge = time.Duration(*c.Request.MaxBundleAge) * time.Millisecond
	}

	result := attestation.VerifyHostname(context.Background(), params)

	if !c.Expect.OK {
		if result.OK {
			t.Fatalf("expected a denial at stage %q, got a verdict of ok", c.Expect.Stage)
		}
		if string(result.Stage) != c.Expect.Stage {
			t.Fatalf("stage = %q, want %q (reason: %s)", result.Stage, c.Expect.Stage, result.Reason)
		}
		if c.Expect.ReasonContains != "" && !strings.Contains(result.Reason, c.Expect.ReasonContains) {
			t.Errorf("reason %q does not contain %q", result.Reason, c.Expect.ReasonContains)
		}
		return
	}

	if !result.OK {
		t.Fatalf("expected ok, got a denial at %q: %s", result.Stage, result.Reason)
	}
	if string(result.Kind) != c.Expect.Kind {
		t.Errorf("kind = %q, want %q", result.Kind, c.Expect.Kind)
	}
	if string(result.ChannelBinding) != c.Expect.ChannelBinding {
		t.Errorf("channelBinding = %q, want %q", result.ChannelBinding, c.Expect.ChannelBinding)
	}
	if result.MatchedRoot.Name != c.Expect.MatchedRoot {
		t.Errorf("matchedRoot = %q, want %q", result.MatchedRoot.Name, c.Expect.MatchedRoot)
	}
	assertJSONEqual(t, "payload", result.Payload.Raw(), c.Expect.Payload)
	assertQuote(t, result.RootCaTeeQuote, c.Expect.RootCaTeeQuote)
}

// caseFetcher answers exactly the URL the case describes. A verifier that
// reaches for any other hostname fails the case rather than silently passing.
func caseFetcher(t *testing.T, dir string, c conformanceCase) attestation.Fetcher {
	t.Helper()
	body := []byte(c.Response.BodyText)
	if c.Response.BodyFile != "" {
		raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(c.Response.BodyFile)))
		if err != nil {
			t.Fatalf("read body file: %v", err)
		}
		body = raw
	}

	return func(_ context.Context, hostname string, _ attestation.FetchOptions) (*attestation.FetchResult, error) {
		if hostname != c.Request.Hostname {
			return nil, errors.New("verifier fetched " + hostname + ", want " + c.Request.Hostname)
		}
		fingerprint := ""
		if c.Request.ObservedTLSFingerprint != nil {
			fingerprint = *c.Request.ObservedTLSFingerprint
		}
		return &attestation.FetchResult{
			URL:                    "https://" + hostname + attestation.EvidencePath,
			StatusCode:             c.Response.Status,
			Body:                   body,
			ObservedTLSFingerprint: fingerprint,
		}, nil
	}
}

// TestConformanceEvidenceDigest holds the pin parser to the same spellings the
// TypeScript one accepts. The final-character rule is the load-bearing part: a
// pin is compared as an exact string, so a second spelling of the same 32 bytes
// would be a pin that never matches.
func TestConformanceEvidenceDigest(t *testing.T) {
	t.Parallel()
	vectors := readJSON[digestVectors](t, filepath.Join(sharedFixtures(t), "evidence-digest.json"))

	for _, c := range vectors.Cases {
		t.Run(c.Note, func(t *testing.T) {
			t.Parallel()
			normalized, err := attestation.NormalizeEvidenceDigest(c.Input)
			if !c.Valid {
				if err == nil {
					t.Fatalf("NormalizeEvidenceDigest(%q) = %q, want a rejection (%s)", c.Input, normalized, c.Note)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizeEvidenceDigest(%q): %v (%s)", c.Input, err, c.Note)
			}
			if normalized != c.Canonical {
				t.Fatalf("NormalizeEvidenceDigest(%q) = %q, want %q", c.Input, normalized, c.Canonical)
			}
		})
	}

	assertCanonicalFinalCharacters(t, vectors.CanonicalFinalCharacters)
}

// assertCanonicalFinalCharacters walks the whole base64url alphabet in the final
// position of a digest and checks the parser accepts exactly the set the vectors
// publish.
func assertCanonicalFinalCharacters(t *testing.T, want string) {
	t.Helper()
	if want == "" {
		t.Skip("vectors do not publish canonicalFinalCharacters")
	}
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

	canonical, err := attestation.NormalizeEvidenceDigest(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	prefix := strings.TrimPrefix(canonical, attestation.FingerprintPrefix)
	prefix = prefix[:len(prefix)-1]

	var accepted strings.Builder
	for i := range len(alphabet) {
		if _, err := attestation.NormalizeEvidenceDigest(attestation.FingerprintPrefix + prefix + string(alphabet[i])); err == nil {
			accepted.WriteByte(alphabet[i])
		}
	}
	if accepted.String() != want {
		t.Fatalf("accepted final characters %q, vectors say %q", accepted.String(), want)
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

func readJSON[T any](t *testing.T, path string) T {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return value
}

// assertJSONEqual compares two JSON documents member by member, so field order
// and formatting differences between implementations do not matter.
func assertJSONEqual(t *testing.T, label string, got, want json.RawMessage) {
	t.Helper()
	if len(want) == 0 {
		return
	}
	var gotValue, wantValue any
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatalf("parse %s produced by the verifier: %v", label, err)
	}
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatalf("parse expected %s: %v", label, err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Errorf("%s =\n%s\nwant\n%s", label, got, want)
	}
}

// assertQuote compares the passed-through quote with what the vectors publish.
// The verifier must hand back the bytes the endpoint served, so this is a
// document comparison, not a struct one.
func assertQuote(t *testing.T, got, want json.RawMessage) {
	t.Helper()
	if len(want) == 0 {
		if got != nil {
			t.Errorf("rootCaTeeQuote = %s, want none", got)
		}
		return
	}
	if got == nil {
		t.Fatalf("rootCaTeeQuote is absent, want %s", want)
	}
	assertJSONEqual(t, "rootCaTeeQuote", got, want)
}
