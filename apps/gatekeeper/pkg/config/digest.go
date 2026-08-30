package config

import (
	"strings"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
)

// hexScheme is the `sha256:<hex>` spelling accepted as config-input sugar.
const hexScheme = "sha256:"

// ParseEvidenceDigest normalises a pinned digest as it may be spelled in a
// config file, and is the only place that decides what a config accepts.
//
// The verdict is [attestation.NormalizeEvidenceDigest]'s — the parser held to
// libs/attestation-fixtures/vectors/evidence-digest.json, which the TypeScript
// tooling implements too — so a pin this file loads is a pin the rest of the
// product agrees is a digest. Accepted: `sha256/<43 canonical base64url chars>`
// (one trailing `=` tolerated), `sha256/<64 hex>`, bare hex, and, on top of the
// vectors, `sha256:<64 hex>`: hex is unambiguous on sight, and `sha256:<hex>`
// is how registries and `openssl dgst` print a digest a user then pastes here.
//
// A bare base64url token with no scheme is rejected, as is a base64url spelling
// whose final character carries non-zero trailing bits. Both are permissive-only
// mistakes, and both would be silent: pins are compared as exact strings, so a
// second spelling of the same 32 bytes is a pin that never fires.
func ParseEvidenceDigest(value string) (string, error) {
	body := strings.TrimSpace(value)
	if hex, ok := strings.CutPrefix(body, hexScheme); ok {
		// Strip the scheme and let the shared parser decide, so
		// `sha256:<base64url>` stays rejected along with every other bare token.
		body = hex
	}
	return attestation.NormalizeEvidenceDigest(body)
}

// IsEvidenceDigest reports whether value is a spelling [ParseEvidenceDigest]
// accepts.
func IsEvidenceDigest(value string) bool {
	_, err := ParseEvidenceDigest(value)
	return err == nil
}
