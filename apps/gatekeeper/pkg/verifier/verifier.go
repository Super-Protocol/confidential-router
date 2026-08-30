// Package verifier answers the question a user actually asks — "would this
// endpoint be let through, and why?" — by joining the two halves that decide
// it: the attestation pipeline (pkg/attestation, stages 1–6 of ADR-003 §1) and
// the policy layer (pkg/policy, stage 7).
//
// It produces a [status.Report]: one value carrying the verdict, the evidence
// behind it and every policy's contribution, which is what `gatekeeper verify`
// prints and the dashboard's detail pane shows. Nothing here decides anything
// on its own; it is wiring, and it is the wiring the data plane will reuse.
package verifier

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/policy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// Verifier holds everything a verification needs that does not change between
// runs: the resolved trust state and the compiled policy set. Building it is
// where a malformed root or an uncompilable policy is caught.
type Verifier struct {
	cfg    *config.Config
	store  *trust.Store
	engine *policy.Engine

	// now overrides the clock, and fetch the transport. Both exist for tests;
	// the zero values are the real ones.
	now   func() time.Time
	fetch attestation.Fetcher
}

// New compiles the trust store and the policy engine from a loaded config.
func New(ctx context.Context, cfg *config.Config) (*Verifier, error) {
	store, err := trust.New(cfg)
	if err != nil {
		return nil, err
	}
	modules, err := policy.LoadModules(cfg)
	if err != nil {
		return nil, err
	}
	engine, err := policy.New(ctx, policy.Options{Store: store, Modules: modules})
	if err != nil {
		return nil, err
	}
	return &Verifier{cfg: cfg, store: store, engine: engine}, nil
}

// WithClock replaces the clock used for freshness and for the report's
// timestamps.
func (v *Verifier) WithClock(now func() time.Time) *Verifier {
	v.now = now
	return v
}

// WithFetcher replaces how the evidence document is retrieved. Only the real
// [attestation.Fetch] can observe the TLS channel, so a substitute has to
// supply the observed fingerprint itself or every verdict falls back to the
// producer-asserted binding the gatekeeper does not accept.
func (v *Verifier) WithFetcher(fetch attestation.Fetcher) *Verifier {
	v.fetch = fetch
	return v
}

func (v *Verifier) clock() time.Time {
	if v.now != nil {
		return v.now()
	}
	return time.Now()
}

// Verify implements [status.Verifier].
//
// It never reports a partial success: a bundle that fails any of stages 1–6
// comes back with Verified false and the stage that rejected it, and the
// policies are not evaluated at all — Rego must never run on unverified
// evidence (ADR-003 §1).
func (v *Verifier) Verify(ctx context.Context, req status.VerifyRequest) (*status.Report, error) {
	endpoint, configured := v.resolve(req)

	// An explicit hostname wins over the endpoint's own: `verify <host>
	// --endpoint <name>` means "fetch from there, judge it by these pins",
	// which is how a staged deployment is checked before it is pinned.
	hostname, port := req.Hostname, req.Port
	if hostname == "" {
		hostname, port = endpoint.Hostname, endpoint.Port
	}
	if hostname == "" {
		return nil, fmt.Errorf("verify: no hostname to verify")
	}
	if port == 0 {
		port = 443
	}

	report := &status.Report{
		Endpoint:  endpoint.Name,
		Hostname:  hostname,
		Port:      port,
		CheckedAt: v.clock(),
	}
	if !configured {
		report.Endpoint = hostname
		report.Warnings = append(report.Warnings,
			hostname+" is not a configured endpoint: it has no pinned evidenceDigest, "+
				"so it can be verified but never admitted")
	}

	// The fetched document is kept so the report can show the chain and the
	// quote, which the verifier's own result does not carry.
	var fetched *attestation.FetchResult
	capture := func(ctx context.Context, host string, opts attestation.FetchOptions) (*attestation.FetchResult, error) {
		inner := v.fetch
		if inner == nil {
			inner = attestation.Fetch
		}
		result, err := inner(ctx, host, opts)
		fetched = result
		return result, err
	}

	tuning := v.tuning(endpoint.Name)
	result := attestation.VerifyHostname(ctx, attestation.Params{
		Hostname:     hostname,
		TrustedRoots: v.trustedRoots(),
		MaxBundleAge: tuning.MaxBundleAge,
		Now:          v.clock(),
		Fetch:        attestation.FetchOptions{Port: port, Timeout: tuning.InitialTimeout},
		Fetcher:      capture,
	})

	report.ObservedTLSFingerprint = result.ObservedTLSFingerprint
	v.describeBundle(report, fetched)

	if !result.OK {
		report.Stage = string(result.Stage)
		report.Reason = result.Reason
		return report, nil
	}

	report.Verified = true
	report.Kind = string(result.Kind)
	report.Root = result.MatchedRoot.Name
	report.RootFingerprint = result.MatchedRoot.Fingerprint
	// A matched root is a trusted one, so the "add this root" affordance the
	// dashboard offers no longer applies.
	report.UntrustedRoot, report.UntrustedRootPEM = "", ""

	base := result.Payload.Base()
	report.CertFingerprint = base.CertFingerprint
	if issued, err := time.Parse(time.RFC3339, base.IssuedAt); err == nil {
		report.IssuedAt = issued
	}

	payload, err := payloadMap(result.Payload)
	if err != nil {
		return nil, err
	}
	if deployment, ok := result.Deployment(); ok && deployment.EvidenceDigest != "" {
		digest, parseErr := trust.ParseDigest(deployment.EvidenceDigest)
		if parseErr != nil {
			return nil, fmt.Errorf("verify: evidenceDigest: %w", parseErr)
		}
		report.EvidenceDigest = digest.String()
		report.Pinned = configured && endpoint.IsPinned(digest)
	}

	input, err := policy.BuildInput(policy.InputSource{
		Endpoint:               report.Endpoint,
		UpstreamHostname:       hostname,
		UpstreamPort:           port,
		Root:                   result.MatchedRoot.Name,
		RootFingerprint:        trust.Digest(result.MatchedRoot.Fingerprint),
		ObservedTLSFingerprint: trust.Digest(result.ObservedTLSFingerprint),
		VerifiedAt:             report.CheckedAt,
		QuoteFormat:            report.QuoteFormat,
		Payload:                payload,
	})
	if err != nil {
		return nil, err
	}
	report.Images = imagesOf(input)

	decision := v.engine.Evaluate(ctx, input)
	for _, pkg := range decision.Packages {
		report.Policies = append(report.Policies, status.PolicyResult{
			Package: pkg.Package, Policy: pkg.Policy, Allow: pkg.Allow, Error: pkg.Error,
		})
	}
	report.Admitted = decision.Allow
	if !decision.Allow {
		report.Reason = decision.Reason
		report.Stage = "policy"
	}
	return report, nil
}

// resolve picks the endpoint a request is about: the one it names, the one
// whose upstream is the host, or none.
func (v *Verifier) resolve(req status.VerifyRequest) (trust.Endpoint, bool) {
	if req.Endpoint != "" {
		if ep, ok := v.store.Endpoint(req.Endpoint); ok {
			return ep, true
		}
	}
	for _, ep := range v.store.Endpoints() {
		if req.Hostname != "" && ep.Hostname == req.Hostname {
			return ep, true
		}
	}
	return trust.Endpoint{}, false
}

// tuning resolves an endpoint's knobs, falling back to the global defaults for
// a host that is not configured.
func (v *Verifier) tuning(name string) config.Tuning {
	if ep, ok := v.cfg.Endpoint(name); ok {
		return v.cfg.Tuning(ep)
	}
	return v.cfg.Tuning(config.Endpoint{})
}

// trustedRoots renders the store in the shape the verifier takes. The DER is
// re-encoded rather than the file re-read, so what is checked is exactly what
// the store resolved and fingerprinted.
func (v *Verifier) trustedRoots() []attestation.TrustedRoot {
	roots := v.store.Roots()
	out := make([]attestation.TrustedRoot, 0, len(roots))
	for _, root := range roots {
		out = append(out, attestation.TrustedRoot{
			Name: root.Name,
			PEM:  string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: root.Certificate.Raw})),
		})
	}
	return out
}

// describeBundle fills in what only the fetched document knows: the chain as
// certificates a human can read, the quote's format, and — when the chain ends
// somewhere untrusted — the root the dashboard can offer to add.
//
// It is deliberately best-effort and runs before the verdict is known: a
// rejected bundle is exactly the one whose chain the operator needs to see.
func (v *Verifier) describeBundle(report *status.Report, fetched *attestation.FetchResult) {
	if fetched == nil || len(fetched.Body) == 0 {
		return
	}
	var bundle struct {
		CertChain      []string `json:"certChain"`
		RootCaTeeQuote *struct {
			Format string `json:"format"`
		} `json:"rootCaTeeQuote"`
	}
	if err := json.Unmarshal(fetched.Body, &bundle); err != nil {
		return
	}
	if bundle.RootCaTeeQuote != nil {
		report.QuoteFormat = bundle.RootCaTeeQuote.Format
	}

	for i, encoded := range bundle.CertChain {
		block, _ := pem.Decode([]byte(encoded))
		if block == nil {
			continue
		}
		isRoot := i == len(bundle.CertChain)-1
		fingerprint := attestation.SHA256Fingerprint(block.Bytes)
		entry := status.Certificate{Fingerprint: fingerprint, Root: isRoot}
		// A key on a curve crypto/x509 does not know still has a usable subject
		// and validity window, so a parse failure loses detail rather than the
		// whole row.
		if cert, err := x509.ParseCertificate(block.Bytes); err == nil {
			entry.Subject = cert.Subject.String()
			entry.Issuer = cert.Issuer.String()
			entry.NotBefore, entry.NotAfter = cert.NotBefore, cert.NotAfter
		}
		report.Chain = append(report.Chain, entry)

		if isRoot {
			report.RootFingerprint = fingerprint
			if _, trusted := v.store.RootByFingerprint(trust.Digest(fingerprint)); !trusted {
				report.UntrustedRoot = fingerprint
				report.UntrustedRootPEM = encoded
			}
		}
	}
}

// payloadMap re-decodes the verified payload into the generic map the policy
// input is built from. The bytes are the ones the JWS was signed over, so
// nothing the signature covered is lost on the way through.
func payloadMap(p attestation.Payload) (map[string]any, error) {
	var out map[string]any
	if err := json.Unmarshal(p.Raw(), &out); err != nil {
		return nil, fmt.Errorf("verify: the verified payload is not a JSON object: %w", err)
	}
	return out, nil
}

// imagesOf reads back the container images the policy input already collected,
// rather than walking the snapshot a second time with different rules.
func imagesOf(input map[string]any) []string {
	evidence, ok := input["evidence"].(map[string]any)
	if !ok {
		return nil
	}
	images, ok := evidence["containerImages"].([]string)
	if !ok {
		return nil
	}
	return images
}
