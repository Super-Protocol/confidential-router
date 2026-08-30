package testing

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// VerifierOptions tunes the adapter [NewVerifier] builds.
type VerifierOptions struct {
	// ObservedTLSFingerprint binds the verdict to a TLS leaf the caller saw on
	// its own handshake — the only binding the data plane accepts. Offline
	// there is no handshake; leaving it empty lets the pipeline fall back to
	// hashing the bundle's tlsLeaf, which is recorded as a warning because a
	// producer-asserted binding proves nothing about the channel.
	ObservedTLSFingerprint string
	// MaxBundleAge rejects bundles whose payload.issuedAt is older than this.
	// Zero disables the freshness check — attestation.Params' own default, and
	// the right one for a saved bundle, since `policy test` is routinely run on
	// a file captured days ago. It is reported as a warning either way.
	MaxBundleAge time.Duration
	// Now overrides the clock used by the validity window and the freshness
	// check. Zero means time.Now.
	Now time.Time
}

// NewVerifier builds the default [VerifyFunc]: the real pkg/attestation
// pipeline (chain → trusted root → JWS → freshness → channel binding) behind
// the seam [Options.Verify] reserves for it.
//
// The trusted roots are read out of cfg and parsed here, so a malformed
// `pem`/`pemFile` is an error at construction rather than a denial per bundle.
// A bundle that fails any stage comes back as an error naming the stage, so a
// cryptographic failure can never be reported as a policy verdict.
//
// The returned function ignores its context: verification of an in-memory
// bundle does no I/O, and the parameter exists for the callers that fetch.
func NewVerifier(cfg *config.Config, opts VerifierOptions) (VerifyFunc, error) {
	if cfg == nil {
		return nil, fmt.Errorf("verifier: a config is required")
	}
	roots := make([]attestation.TrustedRoot, 0, len(cfg.TrustedRoots))
	for _, root := range cfg.TrustedRoots {
		pemBytes, err := cfg.PEM(root)
		if err != nil {
			return nil, fmt.Errorf("trusted root %q: %w", root.Name, err)
		}
		roots = append(roots, attestation.TrustedRoot{Name: root.Name, PEM: string(pemBytes)})
	}

	return func(_ context.Context, bundleJSON []byte, hostname string) (*Verified, error) {
		result := attestation.VerifyBundle(bundleJSON, attestation.Params{
			Hostname:               hostname,
			TrustedRoots:           roots,
			ObservedTLSFingerprint: opts.ObservedTLSFingerprint,
			MaxBundleAge:           opts.MaxBundleAge,
			Now:                    opts.Now,
		})
		if !result.OK {
			return nil, result.Error()
		}
		return newVerified(result, opts)
	}, nil
}

// newVerified converts a successful [attestation.Result] into the shape the
// policy layer consumes, and names every weaker guarantee the offline run had
// to settle for.
func newVerified(result attestation.Result, opts VerifierOptions) (*Verified, error) {
	var payload map[string]any
	if err := json.Unmarshal(result.Payload.Raw(), &payload); err != nil {
		return nil, fmt.Errorf("verified payload is not a JSON object: %w", err)
	}

	rootFingerprint, err := trust.ParseDigest(result.MatchedRoot.Fingerprint)
	if err != nil {
		return nil, fmt.Errorf("matched root fingerprint: %w", err)
	}

	var warnings []string
	// The pipeline proved payload.certFingerprint matches whichever leaf it
	// could reach. When that was the bundle's own tlsLeaf rather than an
	// observed handshake, the binding is the producer's word — the policy input
	// still spells it `observed`, so say so here.
	bound := result.ObservedTLSFingerprint
	if result.ChannelBinding != attestation.BindingObserved || bound == "" {
		bound = result.Payload.Base().CertFingerprint
		warnings = append(warnings,
			"channel binding is producer-asserted (the bundle's own tlsLeaf), not a TLS leaf observed on a handshake")
	}
	observed, err := trust.ParseDigest(bound)
	if err != nil {
		return nil, fmt.Errorf("channel binding fingerprint: %w", err)
	}
	if opts.MaxBundleAge <= 0 {
		warnings = append(warnings,
			"freshness was not enforced: maxBundleAge is 0, so a bundle of any age passes the jws stage")
	}

	verifiedAt := opts.Now
	if verifiedAt.IsZero() {
		verifiedAt = time.Now()
	}

	return &Verified{
		Root:                   result.MatchedRoot.Name,
		RootFingerprint:        rootFingerprint,
		ObservedTLSFingerprint: observed,
		VerifiedAt:             verifiedAt,
		QuoteFormat:            quoteFormat(result.RootCaTeeQuote),
		Payload:                payload,
		Warnings:               warnings,
	}, nil
}

// quoteFormat reads `rootCaTeeQuote.format` for display. The quote itself is
// never validated (ADR-003 §2), so an unreadable one is simply not reported.
func quoteFormat(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var quote struct {
		Format string `json:"format"`
	}
	if err := json.Unmarshal(raw, &quote); err != nil {
		return ""
	}
	return quote.Format
}
