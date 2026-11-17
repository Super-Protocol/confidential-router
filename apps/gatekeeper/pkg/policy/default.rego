# Built-in gatekeeper policy. Always loaded, cannot be disabled, and ANDed with
# every user policy (ADR-003 §4-5), so a user policy can only narrow trust.
#
# Each endpoint declares *one* trust mode in the config, and this policy has one
# clause per mode — the third being the first two at once. `data.gatekeeper.trust` is generated from that config on
# every load, so both clauses are exact comparisons against generated sets.
package gatekeeper.default

default allow := false

# `trust: evidence-digest` (the default) — an endpoint is admitted only for an
# evidenceDigest its owner pinned. `input.evidence.evidenceDigest` is normalised
# to the canonical `sha256/<base64url>` form before evaluation, so this is an
# exact match. A digest identifies one deployment.
allow if {
	input.attestation.verified == true
	endpoint := data.gatekeeper.trust.endpoints[input.endpoint]
	endpoint.trust == "evidence-digest"
	some digest in endpoint.evidence_digests
	digest == input.evidence.evidenceDigest
}

# `trust: cloud-measurement` (ADR-008 §3) — admitted when the upstream's root CA
# passed the attested-root check and the VM measurement that check derived is on
# the operator's `attestedRoots.trustedMeasurements` list.
#
# Weaker than the clause above, deliberately and explicitly: *a measurement
# admits a cloud, never a deployment*. Which workload answers inside that cloud
# is not part of what was verified.
#
# The list is the sole authority here (ADR-008 §3, ruling 2 on SUP-221): the
# membership test is against the configured measurements only, so a measurement
# Super Protocol's registry signed but this operator did not list is *not*
# admitted. `rootAttestation.measurementSource` still reports which anchor
# vouched for it, and a user policy may read it, but it never admits on its own.
allow if {
	input.attestation.verified == true
	endpoint := data.gatekeeper.trust.endpoints[input.endpoint]
	endpoint.trust == "cloud-measurement"
	input.attestation.rootAttestation.attested == true
	some measurement in data.gatekeeper.trust.measurements
	measurement == input.attestation.rootAttestation.measurement
}

# `trust: measurement-and-digest` (SUP-252) — two-factor: the cloud by its
# launch measurement, exactly as the clause above, *and* the deployment by a
# pinned evidenceDigest, exactly as the first clause. Both are required, which
# is what lets a trusted cloud stop admitting every deployment on it (T13).
#
# An endpoint with no pinned digest yet is a legal configuration in this mode —
# it is how trust on first use with an operator in the loop starts — and it is
# never admitted: `some digest in set()` has no member to bind.
allow if {
	input.attestation.verified == true
	endpoint := data.gatekeeper.trust.endpoints[input.endpoint]
	endpoint.trust == "measurement-and-digest"
	input.attestation.rootAttestation.attested == true
	some measurement in data.gatekeeper.trust.measurements
	measurement == input.attestation.rootAttestation.measurement
	some digest in endpoint.evidence_digests
	digest == input.evidence.evidenceDigest
}
