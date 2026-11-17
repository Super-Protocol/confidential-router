package swarmevidence_test

import (
	"context"
	"testing"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/conformance"
)

// TestCompositeConformance replays the shared composite corpus: every case,
// through every appraiser profile the manifest declares, compared as a whole
// SwarmClaims document.
//
// The module's own composite tests build their material in Go and assert the
// claims they care about; this one asserts the claim set other
// implementations will be held to, out of files none of them own. A verifier
// that passes its unit tests and not these has drifted from the contract.
func TestCompositeConformance(t *testing.T) {
	t.Parallel()
	conformance.RunComposite(t, conformance.CompositeImplementation{
		Name: "libs/swarm-evidence-go",
		Appraise: func(ctx context.Context, c conformance.CompositeCase) (swarmevidence.SwarmClaims, error) {
			return swarmevidence.AppraiseComposite(ctx, c.Evidence, c.Options)
		},
	})
}

// TestBundleClaimsConformance replays the /.well-known/swarm-evidence corpus
// as claim sets: the same 31 cases, asked what a relying party's policy may
// conclude rather than whether the bundle verified.
func TestBundleClaimsConformance(t *testing.T) {
	t.Parallel()
	conformance.RunClaims(t, conformance.ClaimsImplementation{
		Name: "libs/swarm-evidence-go",
		Appraise: func(ctx context.Context, c conformance.ClaimsCase) (swarmevidence.SwarmClaims, error) {
			return swarmevidence.AppraiseComposite(ctx, c.Bundle, c.Options)
		},
	})
}
