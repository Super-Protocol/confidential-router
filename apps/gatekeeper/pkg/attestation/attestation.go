// Package attestation is the gatekeeper's view of the swarm-evidence claim
// core. The verifier itself lives in the standalone module
// github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go, which a
// bank or a Veraison deployment imports without the router (SUP-647); this
// package is its first consumer and holds nothing but the names the gatekeeper
// uses.
//
// It is deliberately not a mirror of the module's surface. What belongs here is
// what a gatekeeper package references, plus the type of every value this file
// exports — a constant whose type cannot be named is a poor API. Nothing else:
// the file is then the list of what the gatekeeper actually depends on, and a
// reviewer sees that list change. Everything else about the contract, including
// the pipeline and its stages, is documented in the module.
package attestation

import (
	"context"
	"net"
	"time"

	core "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
)

// Where the evidence bundle is published, and the two digest spellings every
// gatekeeper surface prints.
const (
	EvidencePath      = core.EvidencePath
	FingerprintPrefix = core.FingerprintPrefix
	HexPrefix         = core.HexPrefix
)

// The pipeline stages the gatekeeper names. The full set is the module's.
const (
	StageFetch          = core.StageFetch
	StageUntrustedRoot  = core.StageUntrustedRoot
	StageJWS            = core.StageJWS
	StageTLSFingerprint = core.StageTLSFingerprint
)

// BindingObserved is the only channel binding the gatekeeper accepts in
// production: the fingerprint came from its own TLS handshake.
const BindingObserved = core.BindingObserved

// The contract's types, as the gatekeeper refers to them.
type (
	// Stage names the step of the pipeline a verification failed at.
	Stage = core.Stage
	// ChannelBinding records how the signed certFingerprint was tied to a
	// concrete TLS certificate.
	ChannelBinding = core.ChannelBinding
	// EvidenceKind is the kind of evidence a bundle carries.
	EvidenceKind = core.EvidenceKind
	// TrustedRoot is one entry of the user's trust store.
	TrustedRoot = core.TrustedRoot
	// Params configures a verification.
	Params = core.Params
	// Result is the verdict of a verification.
	Result = core.Result
	// Payload is the verified JWS body.
	Payload = core.Payload
	// ParsedChain is a certChain that passed validation.
	ParsedChain = core.ParsedChain
	// Fetcher is the seam a caller supplies an evidence document through.
	Fetcher = core.Fetcher
	// FetchOptions tunes the evidence request.
	FetchOptions = core.FetchOptions
	// FetchResult is a retrieved evidence document and the channel it arrived on.
	FetchResult = core.FetchResult
	// FetchError is a failure to retrieve one; Transport reports the subset
	// that says nothing about the endpoint.
	FetchError = core.FetchError
)

// VerifyHostname fetches the endpoint's evidence bundle and verifies it,
// binding the verdict to the TLS certificate observed on that same fetch.
func VerifyHostname(ctx context.Context, params Params) Result {
	return core.VerifyHostname(ctx, params)
}

// VerifyBundle runs the pipeline over an already-retrieved bundle document.
func VerifyBundle(document []byte, params Params) Result {
	return core.VerifyBundle(document, params)
}

// Fetch retrieves an endpoint's evidence bundle and records the TLS leaf
// certificate of that very connection.
func Fetch(ctx context.Context, hostname string, opts FetchOptions) (*FetchResult, error) {
	return core.Fetch(ctx, hostname, opts)
}

// DialTCP dials an endpoint through the caller's dialer, or a default one.
func DialTCP(ctx context.Context, dial func(context.Context, string, string) (net.Conn, error),
	network, addr string,
) (net.Conn, error) {
	return core.DialTCP(ctx, dial, network, addr)
}

// ValidateChain checks a PEM chain ordered leaf to root.
func ValidateChain(pems []string, now time.Time) (*ParsedChain, error) {
	return core.ValidateChain(pems, now)
}

// RootFingerprintFromPEM is the `sha256/<base64url>` digest of a root's DER.
func RootFingerprintFromPEM(pemBytes string) (string, error) {
	return core.RootFingerprintFromPEM(pemBytes)
}

// SHA256Fingerprint renders a certificate's DER as `sha256/<base64url>`.
func SHA256Fingerprint(der []byte) string { return core.SHA256Fingerprint(der) }

// IsFingerprint reports whether a value is a `sha256/<base64url>` fingerprint.
func IsFingerprint(value string) bool { return core.IsFingerprint(value) }

// FingerprintsEqual compares two fingerprints in either spelling.
func FingerprintsEqual(a, b string) bool { return core.FingerprintsEqual(a, b) }

// FormatDigestHex renders a digest the way every operator-facing surface does.
func FormatDigestHex(value string) string { return core.FormatDigestHex(value) }

// IsEvidenceDigest reports whether a value is a canonical evidence digest.
func IsEvidenceDigest(value string) bool { return core.IsEvidenceDigest(value) }

// NormalizeEvidenceDigest canonicalises the spelling of an evidence digest.
func NormalizeEvidenceDigest(value string) (string, error) {
	return core.NormalizeEvidenceDigest(value)
}

// EvidenceDigestHex renders an evidence digest as hex.
func EvidenceDigestHex(value string) (string, error) { return core.EvidenceDigestHex(value) }

// EvidenceDigestEquals compares two evidence digests in any accepted spelling.
func EvidenceDigestEquals(a, b string) (bool, error) { return core.EvidenceDigestEquals(a, b) }
