# The relying party's decision about one Super Swarm credential request.
#
# `input` is a SwarmClaims v1 document, exactly as `swarm-evidence-go` emits it
# (libs/swarm-evidence-go/schema/swarmclaims.v1.schema.json). `data.swarm.policy`
# is the bank's own configuration — the approved images, the reference builds,
# and the two values it insists on. Nothing Super Protocol ships decides any of
# it: the claim core reports, and this module decides.
#
# This is deliberately where all Super Swarm-specific appraisal lives. The
# bank's single Verifier appraises a hardware quote and nothing else; the
# membership chain, the leader's statement and the node's request envelope
# reach this policy as claims, and it is reading them here rather than teaching
# a Verifier about them that keeps that Verifier unmodified.
#
# Two rules make it safe to read:
#
#   - Every claim is read through `object.get` with a default. An absent claim
#     in Rego makes an expression *undefined*, and an undefined expression makes
#     a `deny` rule body fail — which would silently admit the request the claim
#     was supposed to gate. A missing claim must deny, so it is given a value
#     that denies.
#   - `allow` is the absence of denials, never a list of positive conditions, so
#     adding a check cannot be forgotten in a second place.
package swarm.claims

import rego.v1

default allow := false

allow if count(deny) == 0

# --- the appraisal itself ---------------------------------------------------

# A refusal is never a partial pass: a claim set carrying a denial carries no
# other claim, so this clause has to come before anything that reads one.
deny contains msg if {
	denial := object.get(input, "denial", null)
	denial != null
	msg := sprintf("the appraisal refused at the %s stage: %s", [
		object.get(denial, "stage", "(unnamed)"),
		object.get(denial, "reason", "(no reason given)"),
	])
}

# A document of a version this policy was not written against is not a document
# this policy may judge.
deny contains msg if {
	version := object.get(input, "schema_version", "")
	version != "1"
	msg := sprintf("SwarmClaims version %q is not the version this policy reads (1)", [version])
}

# --- what must have been established ----------------------------------------
#
# The five predicates below are about the workload. These are about whether
# there is a workload to speak of: an unverified quote, a quote that answers
# somebody else's request, or a statement nothing binds to this request would
# make every claim after them decoration.

deny contains msg if {
	some claim in [
		"quote_verified",
		"binding_ok",
		"pki_chain_ok",
		"root_quote_ok",
		"envelope_ok",
		"statement_ok",
		"mrenclave_approved",
	]
	object.get(input, claim, false) != true
	msg := sprintf("%s is not true: %v", [claim, object.get(input, claim, "(the claim is absent)")])
}

# --- the five predicates ----------------------------------------------------

# `image ∈ approved`. Every digest the statement resolved has to be one the
# bank approved — containers and init containers alike, which is why the claim
# is a set and this is `every` rather than `some`. An empty set denies: a
# statement that resolved no digest says nothing about what ran.
#
# The shape is checked before the contents, because `object.get` defaults only
# an *absent* member. A claim set carrying an explicit `"image_digests": null`
# — which this module's emitter never writes, but a hand-assembled or relayed
# document can — would make `count()` and `some … in` undefined, both rules
# below fail, and the image predicate pass. A claim that is not a list of
# digests is not a list of approved digests.
deny contains msg if {
	not is_array(image_digests)
	msg := sprintf("image_digests is %v, which is not a list of image digests", [image_digests])
}

deny contains msg if {
	is_array(image_digests)
	count(image_digests) == 0
	msg := "the statement resolved no image digests, so nothing says what the pod runs"
}

deny contains msg if {
	some digest in image_digests
	not digest in approved_images
	msg := sprintf("image %s is not in the approved set", [digest])
}

# `locked = true`. An unlocked cluster space can still take new workloads, so
# what the statement says about this one stops being true the moment after it
# was signed.
deny contains msg if {
	object.get(input, "locked", false) != true
	msg := "the cluster space is not locked"
}

# `pss_enforce = restricted`.
deny contains msg if {
	enforce := object.get(input, "pss_enforce", "")
	enforce != required_pss_enforce
	msg := sprintf("the Pod Security Standard enforced is %q, and this policy requires %q", [
		enforce,
		required_pss_enforce,
	])
}

# `network_type = trusted`. The claim is the PKI root's own declaration about
# the network it belongs to. The live demonstration stand's root declares
# "untrusted", which is why this is configuration and not a constant — a
# deployment that has to admit the stand sets `required_network_type` there and
# writes down why.
deny contains msg if {
	network := object.get(input, "network_type", "")
	network != required_network_type
	msg := sprintf("the PKI root declares network type %q, and this policy requires %q", [
		network,
		required_network_type,
	])
}

# `spvm_build ∈ reference values`. The build is producer-supplied and proves
# nothing on its own — the image identity is what `mrenclave_approved` settles
# — but a bank that publishes a CoRIM (SUP-640) names builds in it, and a VM
# claiming a build nobody listed is one nobody has reviewed.
deny contains msg if {
	build := object.get(input, "spvm_build", "")
	not build in reference_builds
	msg := sprintf("sp-vm build %q is not one of this policy's reference values", [build])
}

# --- the bank's configuration -----------------------------------------------

image_digests := object.get(input, "image_digests", [])

approved_images := object.get(policy, "approved_images", [])

reference_builds := object.get(policy, "reference_builds", [])

required_pss_enforce := object.get(policy, "required_pss_enforce", "restricted")

required_network_type := object.get(policy, "required_network_type", "trusted")

# The bank's configuration, read from `data.swarm.policy`. The default makes a
# deployment that loaded no configuration deny everything rather than fall
# through to an empty comparison.
default policy := {}

policy := data.swarm.policy
