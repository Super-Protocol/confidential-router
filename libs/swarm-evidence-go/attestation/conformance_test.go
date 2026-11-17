package attestation_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/conformance"
)

// The shared vectors are the contract: every implementation of the
// /.well-known/swarm-evidence verifier — the TypeScript one in libs/attestation
// and this package — must reach the same verdict on every case. The harness
// that replays them, and everything it asserts, lives in libs/swarm-evidence-go/
// conformance so that this package and the gatekeeper's consumer view of it
// cannot drift in what they check.
func TestConformance(t *testing.T) {
	t.Parallel()
	conformance.Run(t, implementation())
}

// TestConformanceEvidenceDigest holds the pin parser to the same spellings the
// TypeScript one accepts.
func TestConformanceEvidenceDigest(t *testing.T) {
	t.Parallel()
	conformance.RunEvidenceDigest(t, implementation())
}

func implementation() conformance.Implementation {
	return conformance.Implementation{
		Name:                    "libs/swarm-evidence-go/attestation",
		Verify:                  verifyCase,
		RootFingerprint:         attestation.RootFingerprintFromPEM,
		NormalizeEvidenceDigest: attestation.NormalizeEvidenceDigest,
		FingerprintPrefix:       attestation.FingerprintPrefix,
	}
}

func verifyCase(ctx context.Context, c conformance.Case) conformance.Verdict {
	params := attestation.Params{
		Hostname: c.Hostname,
		Now:      c.Now,
		Fetcher:  caseFetcher(c),
	}
	for _, root := range c.TrustedRoots {
		params.TrustedRoots = append(params.TrustedRoots,
			attestation.TrustedRoot{Name: root.Name, PEM: root.PEM})
	}
	if c.ObservedTLSFingerprint != nil {
		params.ObservedTLSFingerprint = *c.ObservedTLSFingerprint
	}
	if c.MaxBundleAge != nil {
		params.MaxBundleAge = *c.MaxBundleAge
	}

	result := attestation.VerifyHostname(ctx, params)
	verdict := conformance.Verdict{
		OK:             result.OK,
		Kind:           string(result.Kind),
		ChannelBinding: string(result.ChannelBinding),
		MatchedRoot:    result.MatchedRoot.Name,
		RootCaTeeQuote: result.RootCaTeeQuote,
		Stage:          string(result.Stage),
		Reason:         result.Reason,
	}
	if result.Payload != nil {
		verdict.PayloadRaw = result.Payload.Raw()
	}
	return verdict
}

// caseFetcher answers exactly the request the case describes. A verifier that
// reaches for any other hostname fails the case rather than silently passing.
func caseFetcher(c conformance.Case) attestation.Fetcher {
	return func(_ context.Context, hostname string, _ attestation.FetchOptions) (*attestation.FetchResult, error) {
		if hostname != c.Hostname {
			return nil, errors.New("verifier fetched " + hostname + ", want " + c.Hostname)
		}
		fingerprint := ""
		if c.ObservedTLSFingerprint != nil {
			fingerprint = *c.ObservedTLSFingerprint
		}
		return &attestation.FetchResult{
			URL:                    "https://" + hostname + attestation.EvidencePath,
			StatusCode:             c.Status,
			Body:                   c.Body,
			ObservedTLSFingerprint: fingerprint,
		}, nil
	}
}
