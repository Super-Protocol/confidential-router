package attestation_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/conformance"
)

// The gatekeeper replays the shared vectors through its own view of the claim
// core, not through the core directly: this package is what every other
// gatekeeper package verifies evidence with, and an alias that stopped
// referring to the right thing would be invisible to the module's own suite.
// The harness and its assertions are the module's, so the two cannot drift in
// what they check — only in what they decide, which is the point.
func TestConformance(t *testing.T) {
	t.Parallel()
	conformance.Run(t, implementation())
}

// TestConformanceEvidenceDigest covers the pin parser the trust store compares
// digests with.
func TestConformanceEvidenceDigest(t *testing.T) {
	t.Parallel()
	conformance.RunEvidenceDigest(t, implementation())
}

func implementation() conformance.Implementation {
	return conformance.Implementation{
		Name:                    "apps/gatekeeper/pkg/attestation",
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

// caseFetcher answers exactly the request the case describes.
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
