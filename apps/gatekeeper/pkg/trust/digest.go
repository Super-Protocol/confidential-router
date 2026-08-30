// Package trust holds the gatekeeper's trust state: the global list of trusted
// roots and, per endpoint, the pinned evidenceDigest values (ADR-003 §2–3).
//
// It is where a fingerprint gets its *type*, not a second parser: [ParseDigest]
// delegates the decision to [config.ParseEvidenceDigest], which in turn defers
// to [attestation.NormalizeEvidenceDigest] — the one implementation the shared
// conformance vectors (libs/attestation-fixtures/vectors/evidence-digest.json)
// are run against, and the one the TypeScript tooling mirrors. The wire and
// canonical form is `sha256/<base64url>` (32 bytes, unpadded); hex is accepted
// on input and normalised on the way in. Comparisons are therefore exact string
// comparisons on the canonical form — the same property the generated Rego
// trust module relies on.
package trust

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// Prefix marks the canonical fingerprint form. It is the evidence contract's
// prefix, not a second spelling of it.
const Prefix = attestation.FingerprintPrefix

// Digest is a canonical `sha256/<base64url>` fingerprint. The zero value is
// invalid; every Digest that exists came out of [ParseDigest] or a hashing
// helper, so callers never have to re-check its shape.
type Digest string

// ParseDigest types an accepted spelling of a SHA-256 fingerprint as a Digest.
//
// Which spellings those are is [config.ParseEvidenceDigest]'s decision, held to
// the shared vectors: `sha256/<43 canonical base64url chars>`, `sha256/<hex>`,
// `sha256:<hex>` and bare hex are accepted; a bare base64url token with no
// scheme, and a base64url spelling whose final character carries non-zero
// trailing bits, are rejected rather than normalised. Rejecting them is what
// keeps a pin an exact string match: a second spelling of the same 32 bytes
// would be a pin that never fires.
func ParseDigest(s string) (Digest, error) {
	canonical, err := config.ParseEvidenceDigest(s)
	if err != nil {
		return "", fmt.Errorf(
			"%q is not a SHA-256 digest: expected %s<43 canonical base64url chars>, "+
				"sha256:<64 hex chars> or bare hex", s, Prefix)
	}
	return Digest(canonical), nil
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
	return Digest(attestation.SHA256Fingerprint(data))
}

// Bytes returns the 32 raw digest bytes. A Digest is canonical by construction,
// so this is a decode and not a parse; it returns nil for a value that never
// came out of [ParseDigest].
func (d Digest) Bytes() []byte {
	body, ok := strings.CutPrefix(string(d), Prefix)
	if !ok {
		return nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil || len(decoded) != sha256.Size {
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
