package attestation

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
)

// FingerprintPrefix is the scheme every digest in the evidence contract carries.
const FingerprintPrefix = "sha256/"

// HexPrefix is the scheme every digest the gatekeeper *prints* carries.
//
// The two are a deliberate pair. `sha256/<base64url>` is the wire form: it is
// what the producer signs into the bundle and what a pin is compared as. Hex is
// what a human reads — the browser extension, the router console and every
// registry show it — so it is what the CLI, the dashboard and the config file
// spell, and `sha256:` says which hash without turning the value into a second
// canonical form (ADR-002 §3).
const HexPrefix = "sha256:"

// sha256Bytes is the length of a SHA-256 digest.
const sha256Bytes = 32

// SHA256Fingerprint renders der as the contract's canonical
// `sha256/<base64url>` fingerprint (unpadded).
func SHA256Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return FingerprintPrefix + base64.RawURLEncoding.EncodeToString(sum[:])
}

// IsFingerprint reports whether value has the shape the verifier accepts for a
// fingerprint. It mirrors the loose `^sha256\/[A-Za-z0-9_-]+$` test of the
// TypeScript verifier (libs/swarm-attestation/src/fingerprint.ts) so both
// implementations reach the same verdict on the same bundle. Pinned values go
// through the stricter NormalizeEvidenceDigest instead.
func IsFingerprint(value string) bool {
	rest, ok := strings.CutPrefix(value, FingerprintPrefix)
	if !ok || rest == "" {
		return false
	}
	return isBase64URLAlphabet(rest)
}

// FingerprintsEqual compares two fingerprints without leaking the position of
// the first difference through timing.
func FingerprintsEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// InvalidEvidenceDigestError is returned when a value cannot be read as a
// 32-byte digest. Pinning trust must never silently accept junk, so there is no
// lenient variant.
type InvalidEvidenceDigestError struct{ Value string }

func (e *InvalidEvidenceDigestError) Error() string {
	return fmt.Sprintf("not a valid evidence digest: %q", e.Value)
}

// NormalizeEvidenceDigest accepts `sha256/<base64url>`, `sha256/<hex>`,
// `sha256:<hex>` or bare hex and returns the canonical `sha256/<base64url>`
// form, mirroring libs/types/src/evidence-digest.ts.
//
// `sha256:<hex>` is the form everything user-facing prints and the config file
// records (see [HexPrefix]), so every parser in the product has to read it back;
// it is unambiguous for the same reason bare hex is.
//
// Bare base64url is deliberately not accepted. Hex is unambiguous on sight, so
// a value copied out of a log needs no scheme; a bare 43-character token is not,
// and silently reading it as a digest would make a typo look like a valid pin.
//
// The base64url spelling must be the canonical encoding of exactly 32 bytes:
// 43 characters whose last one leaves the two spare bits of the final sextet
// zero (A E I M Q U Y c g k o s w 0 4 8). Any other final character encodes the
// same bytes under a different spelling, which would let two pins that look
// different compare equal — or, worse, let a pin miss a digest it should match.
// A single trailing `=` is tolerated on input and dropped.
func NormalizeEvidenceDigest(value string) (string, error) {
	trimmed := strings.TrimSpace(value)

	if body, hasPrefix := strings.CutPrefix(trimmed, FingerprintPrefix); hasPrefix {
		if raw, canonical := decodeCanonicalBase64URL(body); canonical {
			return FingerprintPrefix + base64.RawURLEncoding.EncodeToString(raw), nil
		}
	}
	hexBody := trimmed
	// One scheme or the other, never both: `sha256/sha256:…` is not a spelling
	// of anything.
	if body, ok := strings.CutPrefix(trimmed, FingerprintPrefix); ok {
		hexBody = body
	} else if body, ok := strings.CutPrefix(trimmed, HexPrefix); ok {
		hexBody = body
	}
	if raw, err := hex.DecodeString(strings.ToLower(hexBody)); err == nil && len(raw) == sha256Bytes {
		return FingerprintPrefix + base64.RawURLEncoding.EncodeToString(raw), nil
	}
	return "", &InvalidEvidenceDigestError{Value: value}
}

// IsEvidenceDigest reports whether value is already the canonical
// `sha256/<base64url>` form (a single trailing `=` is tolerated, as in the
// TypeScript parser).
func IsEvidenceDigest(value string) bool {
	body, ok := strings.CutPrefix(value, FingerprintPrefix)
	if !ok {
		return false
	}
	_, canonical := decodeCanonicalBase64URL(body)
	return canonical
}

// EvidenceDigestEquals reports whether two spellings denote the same digest.
// Both sides are normalised first, so hex and base64url compare equal.
func EvidenceDigestEquals(a, b string) (bool, error) {
	na, err := NormalizeEvidenceDigest(a)
	if err != nil {
		return false, err
	}
	nb, err := NormalizeEvidenceDigest(b)
	if err != nil {
		return false, err
	}
	return na == nb, nil
}

// FormatDigestHex renders any accepted spelling of a digest as the human-facing
// `sha256:<lowercase hex>` form — the one string the gatekeeper, the console
// and the docs all show for the same 32 bytes.
//
// It is a display helper, so it never fails: a value it cannot read is returned
// unchanged. A fingerprint printed in an unexpected shape tells the reader what
// happened; an empty cell in a verification report does not.
func FormatDigestHex(value string) string {
	body, err := EvidenceDigestHex(value)
	if err != nil {
		return value
	}
	return HexPrefix + body
}

// EvidenceDigestHex returns the lowercase hex spelling of a digest, the
// `*_hex` form the generated Rego trust module exposes alongside the canonical
// one (docs/contracts/rego-input.md).
func EvidenceDigestHex(value string) (string, error) {
	canonical, err := NormalizeEvidenceDigest(value)
	if err != nil {
		return "", err
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(canonical, FingerprintPrefix))
	if err != nil {
		return "", &InvalidEvidenceDigestError{Value: value}
	}
	return hex.EncodeToString(raw), nil
}

// decodeCanonicalBase64URL decodes a base64url digest and reports whether the
// input was its canonical spelling. Re-encoding and comparing is what enforces
// the final-character rule: a sextet with non-zero spare bits decodes fine but
// never encodes back to itself.
func decodeCanonicalBase64URL(body string) ([]byte, bool) {
	unpadded := strings.TrimSuffix(body, "=")
	if !isBase64URLAlphabet(unpadded) {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(unpadded)
	if err != nil || len(raw) != sha256Bytes {
		return nil, false
	}
	if base64.RawURLEncoding.EncodeToString(raw) != unpadded {
		return nil, false
	}
	return raw, true
}

func isBase64URLAlphabet(s string) bool {
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}
