# Built-in gatekeeper policy. Always loaded, cannot be disabled, and ANDed with
# every user policy (ADR-003 §4-5), so a user policy can only narrow trust.
#
# An endpoint is admitted only for an evidenceDigest its owner pinned in the
# config. `data.gatekeeper.trust` is generated from that config on every load;
# `input.evidence.evidenceDigest` is normalised to the canonical
# `sha256/<base64url>` form before evaluation, so this is an exact match.
package gatekeeper.default

default allow := false

allow if {
	input.attestation.verified == true
	some digest in data.gatekeeper.trust.endpoints[input.endpoint].evidence_digests
	digest == input.evidence.evidenceDigest
}
