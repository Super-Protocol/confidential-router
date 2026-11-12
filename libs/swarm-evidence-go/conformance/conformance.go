// Package conformance replays the shared /.well-known/swarm-evidence vectors
// against an implementation of that contract.
//
// The vectors in libs/attestation-fixtures are the contract: every verifier of
// swarm evidence — the TypeScript one in libs/attestation, this repository's Go
// core, the gatekeeper's consumer view of it, and the Intel Trust Authority and
// Veraison adapters of SUP-648 and SUP-649 — must reach the same verdict on
// every case. Before this package each of them replayed the manifest itself,
// which meant each of them could drift in what it asserted as well as in what
// it decided. Here the cases, the normalisation and the assertions live once;
// an implementation supplies only the adapter that runs a case.
//
// It imports testing on purpose: it is a test harness exported across module
// boundaries, so it cannot live in a _test.go file.
package conformance

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// VectorsDir is where the shared vectors live, relative to the repository root.
const VectorsDir = "libs/attestation-fixtures/vectors"

// Root is one entry of a case's trust store.
type Root struct {
	Name        string
	Fingerprint string
	PEM         string
}

// Case is one vector, with the response body already read and the trust store
// already resolved: everything an implementation needs to run it, and nothing
// about how the vectors are laid out on disk.
type Case struct {
	ID          string
	Description string

	// Hostname the bundle must be published for.
	Hostname string
	// TrustedRoots is the store this case configures, in manifest order.
	TrustedRoots []Root
	// ObservedTLSFingerprint is the channel binding the case pins, nil when it
	// pins none — which is how the producer-asserted fallback is exercised.
	ObservedTLSFingerprint *string
	// Now is the clock the case is verified at.
	Now time.Time
	// MaxBundleAge is the freshness window, nil when the case disables it.
	MaxBundleAge *time.Duration

	// Status and Body are what the endpoint answers with.
	Status int
	Body   []byte
}

// Verdict is a case's outcome, in the spelling the vectors use. An
// implementation maps its own result type onto this.
type Verdict struct {
	OK bool

	// Set when OK.
	Kind           string
	ChannelBinding string
	// MatchedRoot is the *name* of the trusted root the chain terminated at.
	MatchedRoot string
	// PayloadRaw is the exact JSON the JWS was signed over.
	PayloadRaw json.RawMessage
	// RootCaTeeQuote is the bundle's quote, passed through verbatim; nil when
	// the bundle carried none.
	RootCaTeeQuote json.RawMessage

	// Set when not OK. Only Stage and the substring the vectors publish are
	// normative; full reason wording may differ between implementations.
	Stage  string
	Reason string
}

// Implementation is the adapter one verifier supplies.
type Implementation struct {
	// Name identifies the implementation in failure messages.
	Name string
	// Verify runs one case and returns its verdict. It must answer the
	// evidence request from Case.Body and Case.Status without touching the
	// network, and must fail the case rather than succeed if the verifier asks
	// for any hostname other than Case.Hostname.
	Verify func(ctx context.Context, c Case) Verdict
	// RootFingerprint is the `sha256/<base64url>` digest of a root PEM, which
	// is the value the trust store matches on.
	RootFingerprint func(pemBytes string) (string, error)
	// NormalizeEvidenceDigest canonicalises the spelling of an evidence
	// digest; it is what a pin is compared as.
	NormalizeEvidenceDigest func(value string) (string, error)
	// FingerprintPrefix is the canonical digest prefix, `sha256/`.
	FingerprintPrefix string
}

// Dir locates the shared vectors by walking up from the test's working
// directory, so a suite works from a worktree, a plain checkout or CI alike —
// and from either module. go:embed cannot reach outside a package directory,
// and the vectors deliberately live in neither module.
func Dir(t testing.TB) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		candidate := filepath.Join(dir, filepath.FromSlash(VectorsDir))
		if info, err := os.Stat(filepath.Join(candidate, "manifest.json")); err == nil && !info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("could not find %s above %s", VectorsDir, dir)
		}
		dir = parent
	}
}

// Run replays every case of the manifest, and checks on the way that the root
// fingerprints the vectors publish are the ones this implementation computes —
// a store that matches on a different value would pass every case for the
// wrong reason.
func Run(t *testing.T, impl Implementation) {
	t.Helper()
	dir := Dir(t)
	manifest := readJSON[manifestFile](t, filepath.Join(dir, "manifest.json"))
	rootsFile := readJSON[rootsFile](t, filepath.Join(dir, manifest.RootsFile))

	roots := map[string]Root{}
	for _, root := range rootsFile.Roots {
		roots[root.Name] = Root{Name: root.Name, Fingerprint: root.Fingerprint, PEM: root.PEM}

		fingerprint, err := impl.RootFingerprint(root.PEM)
		if err != nil {
			t.Fatalf("%s: parse trusted root %q: %v", impl.Name, root.Name, err)
		}
		if fingerprint != root.Fingerprint {
			t.Errorf("%s: root %q fingerprint = %q, vectors say %q",
				impl.Name, root.Name, fingerprint, root.Fingerprint)
		}
	}

	for _, vector := range manifest.Cases {
		t.Run(vector.ID, func(t *testing.T) {
			t.Parallel()
			runCase(t, dir, vector, roots, impl)
		})
	}
}

func runCase(t *testing.T, dir string, vector caseFile, roots map[string]Root, impl Implementation) {
	t.Helper()

	now, err := time.Parse(time.RFC3339, vector.Request.Now)
	if err != nil {
		t.Fatalf("parse now %q: %v", vector.Request.Now, err)
	}
	c := Case{
		ID:                     vector.ID,
		Description:            vector.Description,
		Hostname:               vector.Request.Hostname,
		ObservedTLSFingerprint: vector.Request.ObservedTLSFingerprint,
		Now:                    now,
		Status:                 vector.Response.Status,
		Body:                   []byte(vector.Response.BodyText),
	}
	for _, name := range vector.Request.TrustedRoots {
		root, ok := roots[name]
		if !ok {
			t.Fatalf("case references unknown trusted root %q", name)
		}
		c.TrustedRoots = append(c.TrustedRoots, root)
	}
	if vector.Request.MaxBundleAge != nil {
		age := time.Duration(*vector.Request.MaxBundleAge) * time.Millisecond
		c.MaxBundleAge = &age
	}
	if vector.Response.BodyFile != "" {
		body, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(vector.Response.BodyFile)))
		if err != nil {
			t.Fatalf("read body file: %v", err)
		}
		c.Body = body
	}

	got := impl.Verify(context.Background(), c)

	if !vector.Expect.OK {
		if got.OK {
			t.Fatalf("%s: expected a denial at stage %q, got a verdict of ok", impl.Name, vector.Expect.Stage)
		}
		if got.Stage != vector.Expect.Stage {
			t.Fatalf("%s: stage = %q, want %q (reason: %s)", impl.Name, got.Stage, vector.Expect.Stage, got.Reason)
		}
		if vector.Expect.ReasonContains != "" && !strings.Contains(got.Reason, vector.Expect.ReasonContains) {
			t.Errorf("%s: reason %q does not contain %q", impl.Name, got.Reason, vector.Expect.ReasonContains)
		}
		return
	}

	if !got.OK {
		t.Fatalf("%s: expected ok, got a denial at %q: %s", impl.Name, got.Stage, got.Reason)
	}
	if got.Kind != vector.Expect.Kind {
		t.Errorf("%s: kind = %q, want %q", impl.Name, got.Kind, vector.Expect.Kind)
	}
	if got.ChannelBinding != vector.Expect.ChannelBinding {
		t.Errorf("%s: channelBinding = %q, want %q", impl.Name, got.ChannelBinding, vector.Expect.ChannelBinding)
	}
	if got.MatchedRoot != vector.Expect.MatchedRoot {
		t.Errorf("%s: matchedRoot = %q, want %q", impl.Name, got.MatchedRoot, vector.Expect.MatchedRoot)
	}
	assertJSONEqual(t, impl.Name+": payload", got.PayloadRaw, vector.Expect.Payload)
	assertQuote(t, impl.Name, got.RootCaTeeQuote, vector.Expect.RootCaTeeQuote)
}

// RunEvidenceDigest holds the pin parser to the spellings the vectors publish.
// The final-character rule is the load-bearing part: a pin is compared as an
// exact string, so a second spelling of the same 32 bytes would be a pin that
// never matches.
func RunEvidenceDigest(t *testing.T, impl Implementation) {
	t.Helper()
	vectors := readJSON[digestVectors](t, filepath.Join(Dir(t), "evidence-digest.json"))

	for _, c := range vectors.Cases {
		t.Run(c.Note, func(t *testing.T) {
			t.Parallel()
			normalized, err := impl.NormalizeEvidenceDigest(c.Input)
			if !c.Valid {
				if err == nil {
					t.Fatalf("%s: NormalizeEvidenceDigest(%q) = %q, want a rejection (%s)",
						impl.Name, c.Input, normalized, c.Note)
				}
				return
			}
			if err != nil {
				t.Fatalf("%s: NormalizeEvidenceDigest(%q): %v (%s)", impl.Name, c.Input, err, c.Note)
			}
			if normalized != c.Canonical {
				t.Fatalf("%s: NormalizeEvidenceDigest(%q) = %q, want %q",
					impl.Name, c.Input, normalized, c.Canonical)
			}
		})
	}

	assertCanonicalFinalCharacters(t, impl, vectors.CanonicalFinalCharacters)
}

// assertCanonicalFinalCharacters walks the whole base64url alphabet in the
// final position of a digest and checks the parser accepts exactly the set the
// vectors publish.
func assertCanonicalFinalCharacters(t *testing.T, impl Implementation, want string) {
	t.Helper()
	if want == "" {
		t.Skip("vectors do not publish canonicalFinalCharacters")
	}
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

	canonical, err := impl.NormalizeEvidenceDigest(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatalf("%s: normalize: %v", impl.Name, err)
	}
	prefix := strings.TrimPrefix(canonical, impl.FingerprintPrefix)
	prefix = prefix[:len(prefix)-1]

	var accepted strings.Builder
	for i := range len(alphabet) {
		if _, err := impl.NormalizeEvidenceDigest(impl.FingerprintPrefix + prefix + string(alphabet[i])); err == nil {
			accepted.WriteByte(alphabet[i])
		}
	}
	if accepted.String() != want {
		t.Fatalf("%s: accepted final characters %q, vectors say %q", impl.Name, accepted.String(), want)
	}
}

type manifestFile struct {
	Version      string     `json:"version"`
	Description  string     `json:"description"`
	ReferenceNow string     `json:"referenceNow"`
	RootsFile    string     `json:"rootsFile"`
	Cases        []caseFile `json:"cases"`
}

type caseFile struct {
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

type rootsFile struct {
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
func assertQuote(t *testing.T, name string, got, want json.RawMessage) {
	t.Helper()
	if len(want) == 0 {
		if got != nil {
			t.Errorf("%s: rootCaTeeQuote = %s, want none", name, got)
		}
		return
	}
	if got == nil {
		t.Fatalf("%s: rootCaTeeQuote is absent, want %s", name, want)
	}
	assertJSONEqual(t, name+": rootCaTeeQuote", got, want)
}
