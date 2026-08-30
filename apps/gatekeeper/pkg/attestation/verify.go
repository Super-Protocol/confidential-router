package attestation

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/internal/certparse"
)

// AllowedClockSkew is how far into the future a bundle may be dated before the
// freshness check treats it as a violation rather than benign clock drift.
const AllowedClockSkew = 60 * time.Second

// Params configures a verification. Only Hostname and TrustedRoots are
// required; the zero value of every other field selects the default described
// on it.
type Params struct {
	// Hostname the bundle is published for. The bundle and the JWS payload must
	// both name it.
	Hostname string

	// TrustedRoots is the user's trust store. An empty store is legal and denies
	// everything at the untrusted-root stage.
	TrustedRoots []TrustedRoot

	// ObservedTLSFingerprint pins the channel binding. VerifyHostname fills it
	// in from its own handshake when left empty; VerifyBundle treats an empty
	// value as "no channel access" and falls back to the bundle's tlsLeaf.
	ObservedTLSFingerprint string

	// MaxBundleAge rejects bundles whose payload.issuedAt is older than this.
	// Zero disables the check, matching the TypeScript default.
	MaxBundleAge time.Duration

	// Now overrides the clock for the validity window and the freshness check.
	Now time.Time

	// Fetch tunes the evidence request made by VerifyHostname.
	Fetch FetchOptions

	// Fetcher overrides how the evidence document is retrieved. Nil uses Fetch,
	// which is the only implementation that can observe the TLS channel; a
	// substitute must supply ObservedTLSFingerprint itself or the verdict falls
	// back to the producer-asserted binding.
	Fetcher Fetcher
}

func (p Params) now() time.Time {
	if p.Now.IsZero() {
		return time.Now()
	}
	return p.Now
}

// VerifyHostname fetches the endpoint's evidence bundle and verifies it,
// binding the verdict to the TLS certificate observed on that same fetch.
//
// It never returns an error: every failure is a Result with the stage it
// happened at, so a caller can render or log the denial without unwrapping.
func VerifyHostname(ctx context.Context, params Params) Result {
	if params.Hostname == "" {
		return fail(StageFetch, "hostname must be a non-empty string")
	}
	if params.ObservedTLSFingerprint != "" && !IsFingerprint(params.ObservedTLSFingerprint) {
		return fail(StageTLSFingerprint, "observedTlsFingerprint must match sha256/<base64url>")
	}

	fetcher := params.Fetcher
	if fetcher == nil {
		fetcher = Fetch
	}
	fetched, err := fetcher(ctx, params.Hostname, params.Fetch)
	if err != nil {
		return fail(StageFetch, "%v", err)
	}
	if fetched.StatusCode < 200 || fetched.StatusCode >= 300 {
		result := fail(StageFetch, "unexpected status %d from %s", fetched.StatusCode, fetched.URL)
		result.ObservedTLSFingerprint = fetched.ObservedTLSFingerprint
		return result
	}

	// A caller may pin the fingerprint it expects — re-attestation against the
	// leaf a live verdict was formed over. The pin is checked against what this
	// exchange actually presented rather than replacing it, so a rotated (or
	// substituted) certificate is caught here instead of silently binding the
	// verdict to a certificate nobody saw.
	if params.ObservedTLSFingerprint == "" {
		params.ObservedTLSFingerprint = fetched.ObservedTLSFingerprint
	} else if !FingerprintsEqual(params.ObservedTLSFingerprint, fetched.ObservedTLSFingerprint) {
		result := fail(StageTLSFingerprint, "pinned observedTlsFingerprint %s is not the certificate served (%s)",
			params.ObservedTLSFingerprint, fetched.ObservedTLSFingerprint)
		result.ObservedTLSFingerprint = fetched.ObservedTLSFingerprint
		return result
	}

	result := VerifyBundle(fetched.Body, params)
	result.ObservedTLSFingerprint = fetched.ObservedTLSFingerprint
	return result
}

// VerifyBundle runs the verification pipeline over an already-retrieved bundle
// document. It is the offline entry point — `gatekeeper policy test --bundle`,
// the conformance fixtures — and the shared core of VerifyHostname.
//
// The stages, in order, are fetch (shape) → cert-chain → untrusted-root → jws →
// freshness → tls-fingerprint, matching ADR-003 §1 and the TypeScript verifier.
func VerifyBundle(document []byte, params Params) Result {
	if params.Hostname == "" {
		return fail(StageFetch, "hostname must be a non-empty string")
	}
	if params.ObservedTLSFingerprint != "" && !IsFingerprint(params.ObservedTLSFingerprint) {
		return fail(StageTLSFingerprint, "observedTlsFingerprint must match sha256/<base64url>")
	}

	bundle, errResult := parseBundle(document, params.Hostname)
	if bundle == nil {
		return errResult
	}

	chain, err := ValidateChain(bundle.CertChain, params.now())
	if err != nil {
		return fail(StageCertChain, "%v", err)
	}

	matchedRoot, errResult := matchTrustedRoot(chain.RootFingerprint, params.TrustedRoots)
	if matchedRoot == nil {
		return errResult
	}

	payload, errResult := verifyPayload(bundle, chain.leaf(), params.Hostname)
	if payload == nil {
		return errResult
	}

	if errResult, ok := checkFreshness(payload.Base().IssuedAt, params.MaxBundleAge, params.now()); !ok {
		return errResult
	}

	binding, errResult := checkChannelBinding(payload.Base().CertFingerprint, params.ObservedTLSFingerprint, bundle.TLSLeaf)
	if binding == "" {
		return errResult
	}

	return Result{
		OK:                     true,
		Kind:                   payload.Base().Kind,
		Payload:                payload,
		MatchedRoot:            *matchedRoot,
		RootCaTeeQuote:         bundle.RootCaTeeQuote,
		ChannelBinding:         binding,
		ObservedTLSFingerprint: params.ObservedTLSFingerprint,
	}
}

// parseBundle decodes the document and enforces the bundle shape, field by
// field in the order the TypeScript verifier checks them. Shape failures are
// reported at the fetch stage: from the caller's point of view the endpoint did
// not serve a usable bundle.
func parseBundle(document []byte, expectedHostname string) (*Bundle, Result) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(document, &probe); err != nil {
		var anyValue any
		if json.Unmarshal(document, &anyValue) == nil {
			return nil, fail(StageFetch, "response body is not a JSON object")
		}
		return nil, fail(StageFetch, "failed to parse response body as JSON: %v", err)
	}
	if probe == nil {
		return nil, fail(StageFetch, "response body is not a JSON object")
	}

	if version, ok := jsonString(probe, "version"); !ok || version != "1" {
		return nil, fail(StageFetch, "unsupported bundle version: %s", jsonFieldOrUndefined(probe, "version"))
	}
	kind, ok := jsonString(probe, "kind")
	if !ok || !EvidenceKind(kind).valid() {
		return nil, fail(StageFetch, "unsupported bundle kind: %s", jsonFieldOrUndefined(probe, "kind"))
	}
	hostname, ok := jsonString(probe, "hostname")
	if !ok || hostname == "" {
		return nil, fail(StageFetch, "bundle is missing hostname")
	}
	if hostname != expectedHostname {
		return nil, fail(StageFetch, "bundle hostname %q does not match request hostname", hostname)
	}
	issuedAt, ok := jsonString(probe, "issuedAt")
	if !ok {
		return nil, fail(StageFetch, "bundle is missing issuedAt")
	}
	certFingerprint, ok := jsonString(probe, "certFingerprint")
	if !ok || !strings.HasPrefix(certFingerprint, FingerprintPrefix) {
		return nil, fail(StageFetch, "bundle certFingerprint is malformed")
	}
	jws, ok := jsonString(probe, "jws")
	if !ok || jws == "" {
		return nil, fail(StageFetch, "bundle is missing jws")
	}
	var certChain []string
	if raw, present := probe["certChain"]; !present || json.Unmarshal(raw, &certChain) != nil || len(certChain) == 0 {
		return nil, fail(StageFetch, "bundle certChain is missing or malformed")
	}
	for _, entry := range certChain {
		if entry == "" {
			return nil, fail(StageFetch, "bundle certChain is missing or malformed")
		}
	}

	bundle := &Bundle{
		Version:         "1",
		Kind:            EvidenceKind(kind),
		Hostname:        hostname,
		IssuedAt:        issuedAt,
		CertFingerprint: certFingerprint,
		JWS:             jws,
		CertChain:       certChain,
	}

	if raw, present := probe["rootCaTeeQuote"]; present && string(raw) != "null" {
		if err := json.Unmarshal(raw, &bundle.RootCaTeeQuote); err != nil {
			return nil, fail(StageFetch, "bundle rootCaTeeQuote is malformed")
		}
	}
	if raw, present := probe["tlsLeaf"]; present {
		if json.Unmarshal(raw, &bundle.TLSLeaf) != nil || bundle.TLSLeaf == "" {
			return nil, fail(StageFetch, "bundle tlsLeaf is malformed")
		}
	}
	return bundle, Result{}
}

func matchTrustedRoot(rootFingerprint string, trustedRoots []TrustedRoot) (*MatchedRoot, Result) {
	for _, root := range trustedRoots {
		fingerprint, err := RootFingerprintFromPEM(root.PEM)
		if err != nil {
			return nil, fail(StageUntrustedRoot, "failed to parse trusted root %q: %v", root.Name, err)
		}
		if FingerprintsEqual(fingerprint, rootFingerprint) {
			return &MatchedRoot{Name: root.Name, Fingerprint: fingerprint}, Result{}
		}
	}
	return nil, fail(StageUntrustedRoot, "%s not in trusted store", rootFingerprint)
}

func verifyPayload(bundle *Bundle, leaf *certparse.Certificate, expectedHostname string) (Payload, Result) {
	payload, err := verifyJWS(bundle.JWS, leaf)
	if err != nil {
		return nil, fail(StageJWS, "%v", err)
	}
	base := payload.Base()
	if base.Kind != bundle.Kind {
		return nil, fail(StageJWS, "payload kind %q does not match bundle kind %q", base.Kind, bundle.Kind)
	}
	if base.Hostname != expectedHostname {
		return nil, fail(StageJWS, "payload hostname %q does not match request hostname", base.Hostname)
	}
	return payload, Result{}
}

// checkFreshness rejects bundles older than maxAge, and bundles dated further
// into the future than AllowedClockSkew. A stale bundle is a replay risk: it
// proves what the endpoint looked like once, not what it looks like now.
// Reported at the jws stage, since issuedAt is a signed payload claim.
func checkFreshness(issuedAt string, maxAge time.Duration, now time.Time) (Result, bool) {
	if maxAge <= 0 {
		return Result{}, true
	}
	issued, err := time.Parse(time.RFC3339, issuedAt)
	if err != nil {
		return fail(StageJWS, "payload.issuedAt %q is not a parseable timestamp", issuedAt), false
	}
	age := now.Sub(issued)
	if age > maxAge {
		return fail(StageJWS, "bundle age %dms exceeds maxBundleAge=%dms",
			age.Milliseconds(), maxAge.Milliseconds()), false
	}
	if age < -AllowedClockSkew {
		return fail(StageJWS, "payload.issuedAt is %dms in the future, beyond allowed skew",
			(-age).Milliseconds()), false
	}
	return Result{}, true
}

// checkChannelBinding ties the signed certFingerprint to a concrete TLS
// certificate. The observed fingerprint always wins when the caller has one;
// hashing the bundle's own tlsLeaf is the weaker fallback for verifiers without
// channel access, and the gatekeeper never takes it in production.
func checkChannelBinding(payloadFingerprint, observedFingerprint, tlsLeafPEM string) (ChannelBinding, Result) {
	if observedFingerprint != "" {
		if !FingerprintsEqual(payloadFingerprint, observedFingerprint) {
			return "", fail(StageTLSFingerprint,
				"payload certFingerprint %s does not match observed %s", payloadFingerprint, observedFingerprint)
		}
		return BindingObserved, Result{}
	}

	if tlsLeafPEM != "" {
		cert, err := certparse.ParsePEM(tlsLeafPEM)
		if err != nil {
			return "", fail(StageTLSFingerprint, "failed to parse bundle.tlsLeaf: %v", err)
		}
		derived := SHA256Fingerprint(cert.Raw)
		if !FingerprintsEqual(payloadFingerprint, derived) {
			return "", fail(StageTLSFingerprint,
				"payload certFingerprint %s does not match bundle.tlsLeaf fingerprint %s", payloadFingerprint, derived)
		}
		return BindingProducerAsserted, Result{}
	}

	return "", fail(StageTLSFingerprint, "no observed fingerprint and no tlsLeaf in bundle")
}

// jsonString reads a field that must be a JSON string.
func jsonString(probe map[string]json.RawMessage, key string) (string, bool) {
	raw, present := probe[key]
	if !present {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// jsonFieldOrUndefined renders a field for an error message the way the
// TypeScript verifier does: the bare string when it is one, its JSON otherwise.
func jsonFieldOrUndefined(probe map[string]json.RawMessage, key string) string {
	raw, present := probe[key]
	if !present {
		return "undefined"
	}
	if value, ok := jsonString(probe, key); ok {
		return value
	}
	return string(raw)
}
