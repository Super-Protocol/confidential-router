package conformance

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
)

// CompositeCase is one composite vector, resolved: the collection to appraise,
// the options to appraise it under — including the quote appraiser the profile
// under test configures — and what the vectors say must come out.
type CompositeCase struct {
	ID          string
	Description string
	// Appraiser is the profile this run is using, which is also the value the
	// `quote_appraiser` claim must carry.
	Appraiser string

	// Evidence is the CMW collection, exactly as the file carries it.
	Evidence []byte
	Options  swarmevidence.Options

	Expect CompositeExpect
}

// CompositeImplementation is the adapter one implementation of the claim core
// supplies.
type CompositeImplementation struct {
	// Name identifies the implementation in failure messages.
	Name string
	// Appraise runs one case. It must not reach the network: everything a
	// case needs is in the case.
	Appraise func(ctx context.Context, c CompositeCase) (swarmevidence.SwarmClaims, error)
}

// RunComposite replays every composite case against every appraiser profile
// the manifest declares.
//
// What it asserts is the whole claim set, not a verdict. Two implementations
// that agree on "appraisable" and disagree on `locked` would both pass a
// verdict-shaped corpus and would hand a bank's policy two different answers;
// the claim set is the contract, so the claim set is what is compared.
//
// Running every case through every profile is the second half: a profile is
// configuration — claim names, octet encoding, issuer, verification key — and
// the claim set may not depend on which one appraised the quote, beyond the
// `quote_appraiser` claim that names it. Where a profile cannot appraise a
// case at all, the vectors say so case by case, and a typed denial is what
// must come out.
func RunComposite(t *testing.T, impl CompositeImplementation) {
	t.Helper()
	dir := Dir(t)
	manifest := readJSON[CompositeManifest](t, filepath.Join(dir, "composite", "manifest.json"))
	roots := readJSON[CompositeRootsFile](t, filepath.Join(dir, filepath.FromSlash(manifest.RootsFile)))
	if len(manifest.Appraisers) == 0 {
		t.Fatal("the composite manifest declares no appraiser profiles")
	}

	for _, vector := range manifest.Cases {
		t.Run(vector.ID, func(t *testing.T) {
			t.Parallel()
			evidence := readFile(t, filepath.Join(dir, filepath.FromSlash(vector.EvidenceFile)))
			appraisals := readJSON[AppraisalFile](t, filepath.Join(dir, filepath.FromSlash(vector.AppraisalFile)))

			for _, profile := range manifest.Appraisers {
				t.Run(profile.Name, func(t *testing.T) {
					t.Parallel()
					runCompositeCase(t, impl, vector, profile, appraisals, roots, evidence)
				})
			}
		})
	}
}

func runCompositeCase(
	t *testing.T,
	impl CompositeImplementation,
	vector CompositeCaseFile,
	profile AppraiserProfile,
	appraisals AppraisalFile,
	roots CompositeRootsFile,
	evidence []byte,
) {
	t.Helper()
	now := parseTime(t, vector.Request.Now)
	appraiser, err := NewAppraiser(profile, appraisals, now)
	if err != nil {
		t.Fatalf("build the %q appraiser: %v", profile.Name, err)
	}

	options := swarmevidence.Options{
		FreshnessInput: decodeHex(t, "request.freshnessInput", vector.Request.FreshnessInput),
		RequestTarget:  decodeBase64URL(t, "request.target", vector.Request.Target),
		RequestSubject: decodeBase64URL(t, "request.subject", vector.Request.Subject),
		QuoteAppraiser: appraiser,
		Now:            now,
	}
	if len(vector.Request.ReferenceValues) > 0 {
		options.ReferenceValues = swarmevidence.ReferenceValues{MrEnclaves: vector.Request.ReferenceValues}
	}
	if vector.Request.MaxEvidenceAge != nil {
		options.MaxEvidenceAge = time.Duration(*vector.Request.MaxEvidenceAge) * time.Millisecond
	}
	for _, name := range vector.Request.TrustedRoots {
		found := false
		for _, root := range roots.Roots {
			if root.Name != name {
				continue
			}
			options.PKIRoots = append(options.PKIRoots,
				attestation.TrustedRoot{Name: root.Name, PEM: root.PEM})
			found = true
		}
		if !found {
			t.Fatalf("case references unknown trusted root %q", name)
		}
	}

	expect := vector.Expect
	if override, ok := vector.Expect.Appraisers[profile.Name]; ok && override != nil {
		expect = *override
	}

	claims, err := impl.Appraise(context.Background(), CompositeCase{
		ID:          vector.ID,
		Description: vector.Description,
		Appraiser:   profile.Name,
		Evidence:    evidence,
		Options:     options,
		Expect:      expect,
	})
	assertCompositeClaims(t, impl.Name, profile.Name, expect, claims, err)
}

// assertCompositeClaims holds the result to the claim set the vectors publish.
//
// The denial's reason is checked as a substring and then dropped from the
// comparison: a stage and a fragment are normative everywhere in this corpus,
// full wording never is, and pinning it would make a clearer error message a
// breaking change.
func assertCompositeClaims(
	t *testing.T, implName, profileName string, expect CompositeExpect,
	claims swarmevidence.SwarmClaims, err error,
) {
	t.Helper()
	label := implName + " via " + profileName

	var denial *swarmevidence.Denial
	if err != nil && !asDenial(err, &denial) {
		t.Fatalf("%s: appraisal failed with %v, want either claims or a *Denial", label, err)
	}
	switch {
	case expect.OK && denial != nil:
		t.Fatalf("%s: denied at %q (%s), want the case to be appraisable", label, denial.Stage, denial.Reason)
	case !expect.OK && denial == nil:
		t.Fatalf("%s: appraised, want a denial at stage %q", label, expect.Stage)
	case !expect.OK:
		if string(denial.Stage) != expect.Stage {
			t.Errorf("%s: stage = %q, want %q (reason: %s)", label, denial.Stage, expect.Stage, denial.Reason)
		}
		if expect.ReasonContains != "" && !strings.Contains(denial.Reason, expect.ReasonContains) {
			t.Errorf("%s: reason %q does not contain %q", label, denial.Reason, expect.ReasonContains)
		}
	}

	got := toDocument(t, claims)
	if nested, ok := got["denial"].(map[string]any); ok {
		delete(nested, "reason")
	}
	want := resolveAppraiser(expect.Claims, profileName)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: claims =\n%s\nwant\n%s", label, mustIndent(t, got), mustIndent(t, want))
	}
}

// resolveAppraiser substitutes the running profile's name for the
// placeholder a case writes, so one claim set can be pinned for every
// appraiser: `quote_appraiser` is the one member that is *supposed* to differ
// between them.
func resolveAppraiser(claims map[string]any, profileName string) map[string]any {
	out := make(map[string]any, len(claims))
	for key, value := range claims {
		if value == AppraiserPlaceholder {
			out[key] = profileName
			continue
		}
		out[key] = value
	}
	return out
}

// toDocument renders a claim set the way a relying party receives it, so what
// is compared is the published JSON and not the Go struct behind it.
func toDocument(t *testing.T, claims swarmevidence.SwarmClaims) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("parse claims: %v", err)
	}
	return document
}

func asDenial(err error, target **swarmevidence.Denial) bool {
	return err != nil && errors.As(err, target)
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return raw
}

func parseTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return parsed
}

func decodeHex(t *testing.T, label, value string) []byte {
	t.Helper()
	octets, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("%s is not hex: %v", label, err)
	}
	return octets
}

func decodeBase64URL(t *testing.T, label, value string) []byte {
	t.Helper()
	octets, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		t.Fatalf("%s is not unpadded base64url: %v", label, err)
	}
	return octets
}

func mustIndent(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}
