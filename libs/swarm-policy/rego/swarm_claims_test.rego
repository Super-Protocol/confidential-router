# Unit tests for the Super Swarm claims policy: one that allows, and one per
# denial. They run under `opa test` and, so that a bank's CI does not need the
# OPA binary either, under `go test ./...` in this module.
package swarm.claims_test

import rego.v1

import data.swarm.claims

# approved is the bank's configuration these cases evaluate against.
approved := {
	"approved_images": [
		"sha256:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
		"sha256:b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
	],
	"reference_builds": ["build-448-release"],
	"required_pss_enforce": "restricted",
	"required_network_type": "trusted",
}

# sound is a claim set with every predicate satisfied. Each case below changes
# exactly one thing about it, so a failure names the predicate that broke.
sound := {
	"schema_version": "1",
	"freshness_input": "5a5a5a5a",
	"binding_ok": true,
	"binding_subject_digest": "c0ffee",
	"platform": "tdx-gcp",
	"quote_verified": true,
	"quote_appraiser": "intel-trust-authority",
	"tcb_status": "OK",
	"collateral_checked": true,
	"mrenclave": "9f" ,
	"mrenclave_approved": true,
	"mrenclave_source": "registry",
	"spvm_build": "build-448-release",
	"pki_root_fingerprint": "sha256/abc",
	"pki_chain_ok": true,
	"root_quote_ok": true,
	"network_type": "trusted",
	"statement_signer_fingerprint": "sha256/def",
	"statement_ok": true,
	"envelope_ok": true,
	"node_cert_fingerprint": "sha256/ghi",
	"gpu_attested": false,
	"pod_uid": "pod-7f3a",
	"namespace": "tenant-acme",
	"cluster_space_id": "space-42",
	"image_digests": [
		"sha256:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
		"sha256:b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
	],
	"locked": true,
	"locked_at": "2026-11-13T08:58:00Z",
	"pss_enforce": "restricted",
}

# without returns the sound claim set with one claim removed, which is how an
# "the appraisal never established this" case is written.
without(claim) := json.remove(sound, [claim])

test_allow_a_sound_claim_set if {
	claims.allow with input as sound with data.swarm.policy as approved
}

test_allow_needs_the_configuration if {
	# No `data.swarm.policy` at all: the approved set and the reference builds
	# are then empty, and an empty approved set admits nothing.
	not claims.allow with input as sound
}

# --- the appraisal itself ---------------------------------------------------

test_deny_a_refused_appraisal if {
	refused := {
		"schema_version": "1",
		"freshness_input": "5a5a5a5a",
		"denial": {"stage": "coverage", "reason": "snp-azure is outside the coverage"},
	}
	not claims.allow with input as refused with data.swarm.policy as approved
	some message in claims.deny with input as refused with data.swarm.policy as approved
	contains(message, "refused at the coverage stage")
}

test_deny_another_schema_version if {
	not claims.allow with input as object.union(sound, {"schema_version": "2"}) with data.swarm.policy as approved
}

# --- what must have been established ----------------------------------------

test_deny_an_unverified_quote if {
	not claims.allow with input as object.union(sound, {"quote_verified": false}) with data.swarm.policy as approved
}

test_deny_a_quote_that_answers_another_request if {
	not claims.allow with input as object.union(sound, {"binding_ok": false}) with data.swarm.policy as approved
}

test_deny_a_chain_that_did_not_validate if {
	not claims.allow with input as object.union(sound, {"pki_chain_ok": false}) with data.swarm.policy as approved
}

test_deny_a_root_whose_own_quote_did_not_hold if {
	not claims.allow with input as object.union(sound, {"root_quote_ok": false}) with data.swarm.policy as approved
}

test_deny_a_statement_nothing_binds_to_this_request if {
	not claims.allow with input as object.union(sound, {"envelope_ok": false}) with data.swarm.policy as approved
}

test_deny_an_unsigned_statement if {
	not claims.allow with input as object.union(sound, {"statement_ok": false}) with data.swarm.policy as approved
}

test_deny_an_image_nothing_vouches_for if {
	not claims.allow with input as object.union(sound, {"mrenclave_approved": false}) with data.swarm.policy as approved
}

# An absent claim is not a satisfied one. This is the case that fails first
# when a predicate is written as `input.x != true` instead of through
# `object.get`.
test_deny_an_absent_structural_claim if {
	some claim in [
		"quote_verified",
		"binding_ok",
		"pki_chain_ok",
		"root_quote_ok",
		"envelope_ok",
		"statement_ok",
		"mrenclave_approved",
	]
	not claims.allow with input as without(claim) with data.swarm.policy as approved
}

# --- the five predicates ----------------------------------------------------

test_deny_an_image_outside_the_approved_set if {
	other := object.union(sound, {"image_digests": [
		"sha256:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
		"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	]})
	not claims.allow with input as other with data.swarm.policy as approved
	some message in claims.deny with input as other with data.swarm.policy as approved
	contains(message, "is not in the approved set")
}

test_deny_a_statement_that_resolved_no_image if {
	not claims.allow with input as without("image_digests") with data.swarm.policy as approved
}

# An explicit null is not an absent claim: `object.get` defaults only what is
# missing, so a document that spells the member out as null would slip past
# both image rules if the shape were not checked first.
test_deny_an_explicit_null_image_digests if {
	nulled := object.union(sound, {"image_digests": null})
	not claims.allow with input as nulled with data.swarm.policy as approved
	some message in claims.deny with input as nulled with data.swarm.policy as approved
	contains(message, "not a list of image digests")
}

test_deny_image_digests_that_are_not_a_list if {
	not claims.allow with input as object.union(sound, {"image_digests": "sha256:a1a1"}) with data.swarm.policy as approved
}

test_deny_an_unlocked_cluster_space if {
	not claims.allow with input as object.union(sound, {"locked": false}) with data.swarm.policy as approved
}

test_deny_a_pod_security_standard_below_restricted if {
	below := object.union(sound, {"pss_enforce": "baseline"})
	not claims.allow with input as below with data.swarm.policy as approved
	some message in claims.deny with input as below with data.swarm.policy as approved
	contains(message, "Pod Security Standard")
}

test_deny_an_untrusted_network if {
	untrusted := object.union(sound, {"network_type": "untrusted"})
	not claims.allow with input as untrusted with data.swarm.policy as approved
	some message in claims.deny with input as untrusted with data.swarm.policy as approved
	contains(message, "network type")
}

# The demonstration stand's root declares "untrusted", and a deployment that
# has to admit it says so in its configuration rather than in the policy.
test_allow_an_untrusted_network_when_the_bank_configured_it if {
	untrusted := object.union(sound, {"network_type": "untrusted"})
	relaxed := object.union(approved, {"required_network_type": "untrusted"})
	claims.allow with input as untrusted with data.swarm.policy as relaxed
}

test_deny_a_build_outside_the_reference_values if {
	other := object.union(sound, {"spvm_build": "build-999-local"})
	not claims.allow with input as other with data.swarm.policy as approved
	some message in claims.deny with input as other with data.swarm.policy as approved
	contains(message, "reference values")
}

test_deny_a_claim_set_that_names_no_build if {
	not claims.allow with input as without("spvm_build") with data.swarm.policy as approved
}
