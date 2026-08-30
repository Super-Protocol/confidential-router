// Package trust holds the gatekeeper's trust state: the global list of trusted
// roots and, per endpoint, the pinned evidenceDigest values (ADR-003 §2–3).
//
// It is the single place that knows how a fingerprint is spelled. The wire and
// canonical form is `sha256/<base64url>` (32 bytes, unpadded); `sha256:<hex>`
// and bare hex are accepted on input because that is how humans copy digests
// out of logs and registries, and are normalised on the way in. Comparisons
// are therefore exact string comparisons on the canonical form — the same
// property the generated Rego trust module relies on.
package trust

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
)

// Prefix marks the canonical fingerprint form.
const Prefix = "sha256/"

// Digest is a canonical `sha256/<base64url>` fingerprint. The zero value is
// invalid; every Digest that exists came out of [ParseDigest] or a hashing
// helper, so callers never have to re-check its shape.
type Digest string

// ParseDigest normalises any accepted spelling of a SHA-256 fingerprint.
//
// Accepted: `sha256/<base64url>` (padded or not), `sha256:<hex>`, bare hex.
// Anything else is an error — code that pins trust must never silently accept
// a value it did not understand.
func ParseDigest(s string) (Digest, error) {
	raw := strings.TrimSpace(s)
	if raw == "" {
		return "", fmt.Errorf("empty evidence digest")
	}

	body := raw
	switch {
	case strings.HasPrefix(raw, Prefix):
		body = raw[len(Prefix):]
	case strings.HasPrefix(raw, "sha256:"):
		body = raw[len("sha256:"):]
	}

	// 64 hex characters and 43 base64url characters can never be confused, so
	// the two forms can be tried in either order.
	if len(body) == 2*sha256.Size {
		if decoded, err := hex.DecodeString(strings.ToLower(body)); err == nil {
			return DigestFromBytes(decoded)
		}
	}
	if decoded, err := decodeBase64URL(body); err == nil && len(decoded) == sha256.Size {
		return DigestFromBytes(decoded)
	}
	return "", fmt.Errorf(
		"%q is not a SHA-256 digest: expected sha256/<43 base64url chars>, sha256:<64 hex chars> or bare hex", s)
}

// MustParseDigest is ParseDigest for constants and test fixtures.
func MustParseDigest(s string) Digest {
	d, err := ParseDigest(s)
	if err != nil {
		panic(err)
	}
	return d
}

// DigestFromBytes wraps a raw 32-byte SHA-256 sum.
func DigestFromBytes(sum []byte) (Digest, error) {
	if len(sum) != sha256.Size {
		return "", fmt.Errorf("a SHA-256 digest is %d bytes, got %d", sha256.Size, len(sum))
	}
	return Digest(Prefix + base64.RawURLEncoding.EncodeToString(sum)), nil
}

// Sum hashes arbitrary bytes — the DER of a certificate, the canonical JSON of
// a snapshot — into a Digest.
func Sum(data []byte) Digest {
	sum := sha256.Sum256(data)
	return Digest(Prefix + base64.RawURLEncoding.EncodeToString(sum[:]))
}

// Bytes returns the 32 raw digest bytes.
func (d Digest) Bytes() []byte {
	decoded, err := decodeBase64URL(strings.TrimPrefix(string(d), Prefix))
	if err != nil {
		return nil
	}
	return decoded
}

// Hex renders the lower-case hex form used by `input.evidence.evidenceDigestHex`
// and by most registries.
func (d Digest) Hex() string { return hex.EncodeToString(d.Bytes()) }

// String returns the canonical `sha256/<base64url>` form.
func (d Digest) String() string { return string(d) }

// Equal compares two canonical digests in constant time. The values are public,
// but a pin check is an authorisation decision and should not leak a prefix
// length through timing.
func (d Digest) Equal(other Digest) bool {
	return subtle.ConstantTimeCompare([]byte(d), []byte(other)) == 1
}

func decodeBase64URL(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}
