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
	// its own handshake — the only binding the gatekeeper accepts (ADR-003 §1),
	// and therefore required for an admitted verdict. Offline there is no
	// handshake of our own; a caller that has one (`gatekeeper verify` does)
	// passes its fingerprint here. Leaving it empty lets the pipeline fall back
	// to hashing the bundle's own tlsLeaf, which proves nothing about the
	// channel, so that outcome is reported as a denial rather than an
	// admission.
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
// A bundle that passes every stage but binds to its own tlsLeaf is a denial
// too: [Result.Admitted] means "the gatekeeper would let this through", and the
// gatekeeper admits an observed binding only. Set
// [VerifierOptions.ObservedTLSFingerprint] to get an admissible verdict.
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

	// The pipeline proved payload.certFingerprint matches whichever leaf it
	// could reach. When that was the bundle's own tlsLeaf rather than a leaf
	// seen on a handshake, the binding is the producer's word about itself:
	// stages 1–6 held, but the gatekeeper would still not admit this endpoint,
	// and the policy input has no way to say so — policy.BuildInput spells
	// `channelBinding: observed` unconditionally. Reporting it as a denial is
	// the only honest answer; passing it through as an admission would make
	// `policy test` claim something the data plane never would.
	if result.ChannelBinding != attestation.BindingObserved || result.ObservedTLSFingerprint == "" {
		return nil, fmt.Errorf(
			"%s: channel binding is producer-asserted (the bundle's own tlsLeaf was hashed); "+
				"the gatekeeper admits an observed binding only — supply the TLS leaf fingerprint "+
				"seen on a handshake with the endpoint", attestation.StageTLSFingerprint)
	}
	observed, err := trust.ParseDigest(result.ObservedTLSFingerprint)
	if err != nil {
		return nil, fmt.Errorf("channel binding fingerprint: %w", err)
	}

	var warnings []string
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
