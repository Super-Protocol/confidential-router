package policy

import (
	"fmt"
	"sort"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// ChannelBindingObserved is the only binding the gatekeeper accepts: the
// fingerprint of the TLS leaf it saw itself (ADR-003 §1).
const ChannelBindingObserved = "observed"

// InputSource is everything the verifier learned, in the shape [BuildInput]
// needs. It deliberately does not import the verifier's result type: the policy
// layer only ever sees a payload that already passed stages 1–6, and keeping the
// two packages independent means either can be tested alone. [status] is the
// exception, and only for its plain description of the attested-root check —
// that package is the shared vocabulary of a verification, and restating a
// dozen fields a third time would be worse than the dependency.
type InputSource struct {
	// Endpoint is endpoints[].name — the key policies look trust up under.
	Endpoint string
	// UpstreamHostname and UpstreamPort are what the bundle was fetched from.
	UpstreamHostname string
	UpstreamPort     int
	// Root is the trustedRoots[].name the chain terminated in.
	Root            string
	RootFingerprint trust.Digest
	// ObservedTLSFingerprint is the SHA-256 of the DER leaf seen on the wire.
	ObservedTLSFingerprint trust.Digest
	// VerifiedAt is when the verdict was produced; zero means "now".
	VerifiedAt time.Time
	// QuoteFormat mirrors bundle.rootCaTeeQuote.format when present. The quote
	// is displayed, never validated.
	QuoteFormat string
	// RootAttested marks a root accepted on its own TEE evidence rather than
	// from the user's list, and AttestedRoot is what that check found. Both are
	// nil/false for a root the user pinned, which is what lets a policy say
	// "only manually pinned clouds" — or, the other way round, police the TEE
	// flags of an attested one.
	RootAttested bool
	AttestedRoot *status.AttestedRoot
	// Payload is the verified JWS payload, passed through unchanged apart from
	// the normalisation and convenience fields documented on BuildInput.
	Payload map[string]any
}

// BuildInput assembles the `input` document of schemas/rego-input.schema.json.
//
// The payload is copied through as published and enriched exactly the way
// swarm-cloud's gatekeeper-proxy does (`buildRegoInput`/`collectImages`):
//
//   - `evidenceDigest` and `certFingerprint` are normalised to canonical form,
//     which is what makes the built-in pin policy an exact string match;
//   - `containerImages` flattens every string `image` field of the snapshot;
//   - `evidenceDigestHex` / `certFingerprintHex` give policies the hex spelling
//     without making every rule re-encode base64url.
func BuildInput(src InputSource) (map[string]any, error) {
	if src.Endpoint == "" {
		return nil, fmt.Errorf("policy input: endpoint name is required")
	}
	if src.Payload == nil {
		return nil, fmt.Errorf("policy input: verified payload is required")
	}

	evidence := make(map[string]any, len(src.Payload)+3)
	for k, v := range src.Payload {
		evidence[k] = v
	}

	digest, err := digestField(src.Payload, "evidenceDigest")
	if err != nil {
		return nil, err
	}
	evidence["evidenceDigest"] = digest.String()
	evidence["evidenceDigestHex"] = digest.Hex()

	certFingerprint, err := digestField(src.Payload, "certFingerprint")
	if err != nil {
		return nil, err
	}
	evidence["certFingerprint"] = certFingerprint.String()
	evidence["certFingerprintHex"] = certFingerprint.Hex()

	evidence["containerImages"] = collectImages(src.Payload["evidence"])

	verifiedAt := src.VerifiedAt
	if verifiedAt.IsZero() {
		verifiedAt = time.Now()
	}

	attestation := map[string]any{
		"verified":               true,
		"channelBinding":         ChannelBindingObserved,
		"root":                   src.Root,
		"rootFingerprint":        src.RootFingerprint.String(),
		"observedTlsFingerprint": src.ObservedTLSFingerprint.String(),
		"verifiedAt":             verifiedAt.UTC().Format(time.RFC3339),
	}
	if src.QuoteFormat != "" {
		attestation["quoteFormat"] = src.QuoteFormat
	}
	if root := attestedRootInput(src); root != nil {
		attestation["rootAttestation"] = root
	}

	port := src.UpstreamPort
	if port == 0 {
		port = 443
	}

	return map[string]any{
		"endpoint":    src.Endpoint,
		"upstream":    map[string]any{"hostname": src.UpstreamHostname, "port": port},
		"attestation": attestation,
		"evidence":    evidence,
	}, nil
}

// attestedRootInput renders the attested-root check for Rego, or nil when the
// root came from the user's list.
//
// The TEE flags are exposed as they were read, not as a verdict: an operator
// who wants "Ciphertext Hiding must be on" writes that rule themselves, and one
// who does not must not have it imposed. `attested` is separate from
// `inRegistry` so a policy can distinguish "not one of Super Protocol's images"
// from "the report itself did not hold up".
func attestedRootInput(src InputSource) map[string]any {
	if src.AttestedRoot == nil {
		return nil
	}
	root := src.AttestedRoot
	return map[string]any{
		"attested":          src.RootAttested,
		"evidenceType":      root.EvidenceType,
		"networkType":       root.NetworkType,
		"measurement":       root.Measurement,
		"inRegistry":        root.InRegistry,
		"reportIntegrity":   root.ReportIntegrity,
		"revocationChecked": root.RevocationChecked,
		"notRevoked":        root.NotRevoked,
		"keyBinding":        root.KeyBinding,
		"cpuGeneration":     root.CPUGeneration,
		"teeFlags": map[string]any{
			"vmpl":             float64(root.VMPL),
			"debugAllowed":     root.DebugAllowed,
			"ciphertextHiding": root.CiphertextHiding,
			"pageSwapDisabled": root.PageSwapDisabled,
			"snpFirmwareTcb":   float64(root.SnpFirmwareTCB),
			"reportVersion":    float64(root.ReportVersion),
		},
	}
}

func digestField(payload map[string]any, field string) (trust.Digest, error) {
	raw, ok := payload[field].(string)
	if !ok || raw == "" {
		return "", fmt.Errorf("policy input: verified payload has no %s", field)
	}
	d, err := trust.ParseDigest(raw)
	if err != nil {
		return "", fmt.Errorf("policy input: %s: %w", field, err)
	}
	return d, nil
}

// collectImages flattens every string `image` field of the deployment snapshot,
// de-duplicated and sorted. Sorting is a deliberate difference from the
// TypeScript original, whose order follows JSON key order: a stable order keeps
// the input document — and therefore anything hashed or logged from it —
// reproducible.
func collectImages(snapshot any) []string {
	seen := map[string]struct{}{}
	var walk func(node any)
	walk = func(node any) {
		switch typed := node.(type) {
		case map[string]any:
			if image, ok := typed["image"].(string); ok {
				seen[image] = struct{}{}
			}
			for _, v := range typed {
				walk(v)
			}
		case []any:
			for _, v := range typed {
				walk(v)
			}
		}
	}
	walk(snapshot)

	out := make([]string, 0, len(seen))
	for image := range seen {
		out = append(out, image)
	}
	sort.Strings(out)
	return out
}
