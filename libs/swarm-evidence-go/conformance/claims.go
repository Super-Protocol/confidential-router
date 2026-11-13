package conformance

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
)

// RootQuoteAppraisalFile is `root-quote-appraisal.json`: the recorded
// appraisal of the membership root's own TEE evidence that the bundle
// corpus's claim-set expectations are written against.
type RootQuoteAppraisalFile struct {
	Version     string            `json:"version"`
	Description string            `json:"description"`
	Appraiser   string            `json:"appraiser"`
	Appraisal   RecordedAppraisal `json:"appraisal"`
}

// ClaimsCase is one bundle vector resolved for the claim core: the document
// the endpoint served, and the options to appraise it under.
type ClaimsCase struct {
	ID          string
	Description string
	// Appraiser is the name the `quote_appraiser` claim must carry.
	Appraiser string

	Bundle  []byte
	Options swarmevidence.Options

	Expect CompositeExpect
}

// ClaimsImplementation is the adapter an implementation of the claim core
// supplies for the bundle corpus.
type ClaimsImplementation struct {
	Name     string
	Appraise func(ctx context.Context, c ClaimsCase) (swarmevidence.SwarmClaims, error)
}

// RunClaims replays the bundle corpus as claim sets rather than as verdicts.
//
// It is the same 31 cases [Run] replays, asked a different question. A
// verdict says the bundle verified; the claim set says what a relying party
// may conclude from it, and the two are not the same assertion — three of
// these cases are sound bundles whose claim set is a denial, because the
// claim core reads the root's public key and crypto/x509 has no secp256k1
// parser. A corpus that pinned only verdicts would have left that difference
// to a comment.
func RunClaims(t *testing.T, impl ClaimsImplementation) {
	t.Helper()
	dir := Dir(t)
	manifest := readJSON[manifestFile](t, filepath.Join(dir, "manifest.json"))
	rootsFile := readJSON[rootsFile](t, filepath.Join(dir, manifest.RootsFile))
	recorded := readJSON[RootQuoteAppraisalFile](t, filepath.Join(dir, "root-quote-appraisal.json"))

	roots := map[string]Root{}
	for _, root := range rootsFile.Roots {
		roots[root.Name] = Root{Name: root.Name, Fingerprint: root.Fingerprint, PEM: root.PEM}
	}

	for _, vector := range manifest.Cases {
		t.Run(vector.ID, func(t *testing.T) {
			t.Parallel()
			if vector.Expect.Claims == nil {
				t.Fatalf("case %q carries no claims expectation", vector.ID)
			}
			runClaimsCase(t, impl, dir, vector, roots, recorded)
		})
	}
}

func runClaimsCase(
	t *testing.T,
	impl ClaimsImplementation,
	dir string,
	vector caseFile,
	roots map[string]Root,
	recorded RootQuoteAppraisalFile,
) {
	t.Helper()
	now := parseTime(t, vector.Request.Now)

	options := swarmevidence.Options{
		Subject: vector.Request.Hostname,
		Now:     now,
		// One appraisal stands for both halves: the bundle form appraises the
		// chain's root and nothing per request.
		QuoteAppraiser: &recordedAppraiser{
			name:  recorded.Appraiser,
			root:  recorded.Appraisal,
			quote: recorded.Appraisal,
		},
	}
	for _, name := range vector.Request.TrustedRoots {
		root, ok := roots[name]
		if !ok {
			t.Fatalf("case references unknown trusted root %q", name)
		}
		options.PKIRoots = append(options.PKIRoots,
			attestation.TrustedRoot{Name: root.Name, PEM: root.PEM})
	}
	if vector.Request.ObservedTLSFingerprint != nil {
		options.ObservedTLSFingerprint = *vector.Request.ObservedTLSFingerprint
	}
	if vector.Request.MaxBundleAge != nil {
		options.MaxEvidenceAge = millis(*vector.Request.MaxBundleAge)
	}

	body := []byte(vector.Response.BodyText)
	if vector.Response.BodyFile != "" {
		raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(vector.Response.BodyFile)))
		if err != nil {
			t.Fatalf("read body file: %v", err)
		}
		body = raw
	}

	expect := CompositeExpect{
		OK:             vector.Expect.Claims.OK,
		Stage:          vector.Expect.Claims.Stage,
		ReasonContains: vector.Expect.Claims.ReasonContains,
		Claims:         vector.Expect.Claims.Document,
	}
	claims, err := impl.Appraise(context.Background(), ClaimsCase{
		ID:          vector.ID,
		Description: vector.Description,
		Appraiser:   recorded.Appraiser,
		Bundle:      body,
		Options:     options,
		Expect:      expect,
	})
	assertCompositeClaims(t, impl.Name, recorded.Appraiser, expect, claims, err)
}

// millis is the manifest's freshness window as a duration.
func millis(value int64) time.Duration { return time.Duration(value) * time.Millisecond }
