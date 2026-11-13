# SwarmClaims v1 — claim reference

What an appraisal of Super Swarm Evidence establishes, claim by claim: what it
asserts, what evidence produces it, and what it does **not** assert.

The machine-readable contract is `swarmclaims.v1.schema.json` beside this file.
This page is the prose that goes with it, and it ships in the module so that
whoever writes the policy has it offline.

Pinned to `libs/swarm-evidence-go/v0.1.0`.

## Two rules to read every claim by

**An absent claim was not established.** Only `schema_version` is always
present. Everything else is omitted when the appraisal did not reach an answer
about it, so "false" and "not checked" are never spelled the same way. A policy
that reads a claim must supply its own denying default — in Rego
`object.get(input, "locked", false)`, not `input.locked != true`, which is
undefined for an absent claim and admits the request.

**A refusal is never a partial pass.** Evidence the core cannot appraise
produces `denial {stage, reason}`, and the claim set then carries nothing but
that, `schema_version` and `freshness_input`. There is no claim set that is
half an appraisal.

Two consequences follow for a policy author:

- `mrenclave_approved: false` is a statement — something was asked and the
  answer was that nothing vouches for this image. It is different from the
  claim being absent, which is what an appraiser that derived no image
  identity at all reports.
- A pod claim is only ever reported beside `envelope_ok: true`. A collection
  carrying a statement and no envelope is refused at the `envelope` stage, so
  no policy can read pod facts that nothing binds to its request.

## The two forms, and which claims each sets

**The composite form** — a CMW collection — is about one credential request.
It sets `binding_ok`, `envelope_ok` and the pod claims, and no channel claim.

**The bundle form** — `/.well-known/swarm-evidence` — is about one served
hostname. It sets `channel_binding` and `evidence_digest`, and no request
claim.

In the **composite** form the hardware claims describe the VM that produced the
per-request quote. In the **bundle** form they describe the VM that generated
the PKI root's key, because that is the only quote a bundle carries. The rest
of this page marks each claim with the form or forms that set it.

## Contract

### `schema_version`

**Asserts** the version of this contract. Always `"1"` for SwarmClaims v1.
**Produced by** the module, unconditionally — including on a denial.
**Does not assert** anything about the module's own version: a module release
may fix a verification bug without touching the claim set.

A policy must refuse a document whose `schema_version` it was not written
against. Adding a value to a closed enum below is a new `schema_version`,
precisely because a policy matching on these strings literally would otherwise
fall through to its default.

## Freshness and request binding

### `freshness_input`

**Asserts** nothing. It is the freshness element the appraisal was *asked* to
bind, echoed back in lower-case hex, so a relying party can match an answer to
the challenge it issued.
**Produced by** the caller's own input, hex-encoded. It is reported on every
result, a denial included.
**Does not assert** that the attester ever saw it — that is `binding_ok`. No
Verifier interprets this value; it is copied verbatim.

Its size is the Freshness Kind's, not this module's: 32 octets for the TACRA
Vault profile's `present-nonce` Handle, 8 for its `absent-timestamp`. What is
fixed at 64 octets is the quote field the binding digest goes into, which is a
different value.

### `binding_ok`

*Composite form.*

**Asserts** that the quote's guest-chosen field commits to
`SHA-512(len32‖freshness ‖ len32‖target ‖ len32‖subject)` — that this quote
answers this request.
**Produced by** recomputing that digest locally from the three values the
relying party holds and comparing it with the field the appraiser read out of
the quote in hand. It is never compared against a value an intermediary
reported, which is why a Verifier that does not surface report data is still
usable.
**Does not assert** which request the *statement* beside the quote is about —
that is `envelope_ok` — and it carries no relying-party identifier, so it does
not by itself establish that the evidence was meant for you rather than for
another Vault.

On the Azure branches the field read is the 64-octet HCL user-data, because the
hardware `REPORT_DATA` there is the paravisor's `SHA-256(runtime data JSON) ‖
0³²` and is not guest-chosen at all. An appraiser that will not say which field
it read is refused at the `binding` stage.

### `binding_subject_digest`

*Composite form.*

**Asserts** the SHA-256, in hex, of the request subject the binding covers —
the DER `CertificationRequest` for enrolment, the DER `SubjectPublicKeyInfo` of
CEKpub for retrieval.
**Produced by** hashing the subject octets the caller supplied.
**Does not assert** that the subject is well-formed, or that the key in it is
one you would issue a credential to.

### `channel_binding`

*Bundle form.*

**Asserts** how the signed statement was tied to a concrete TLS certificate:
`observed` means the caller supplied the fingerprint of the leaf it saw on the
connection; `producer-asserted` means the bundle's own copy of the certificate
was hashed instead.
**Produced by** the bundle pipeline, from whether the caller passed an observed
fingerprint.
**Does not assert**, in the `producer-asserted` case, anything about the
connection the claims will be acted on. A policy that cares about channel
binding must refuse that value.

## The hardware quote

### `platform`

**Asserts** the attester's TEE and the cloud it runs in: one of `tdx-qemu`,
`tdx-gcp`, `tdx-azure`, `snp-qemu`, `snp-azure`.
**Produced by** the evidence type the quote declares, read before anything is
appraised.
**Does not assert** that the platform is one your Verifier covers. Read it
first: which claims below are meaningful depends on it.

### `quote_verified`

**Asserts** that the hardware quote's signature and its chain to the CPU
vendor's root were checked and held.
**Produced by** the configured `QuoteAppraiser` — the built-in offline one with
the vendor libraries, or the relying party's own Verifier through the delegated
appraiser.
**Does not assert** anything about the image that was running; that is
`mrenclave` and `mrenclave_approved`. It also says nothing about the TCB level,
which is `tcb_status`.

With the appraisers this module ships, `quote_verified` appears only as `true`:
a quote that did not verify denies at the `root-quote` stage instead. A policy
should still test for `== true` rather than `!= false`, because the appraiser
is replaceable and the interface only requires it to fail closed.

### `quote_appraiser`

**Asserts** what appraised the quote — `builtin` for this module's offline
appraiser, otherwise whatever name the delegated appraiser was configured with.
**Produced by** the appraiser's own `Name()`.
**Does not assert** that the named Verifier is trustworthy, or that the token it
returned was issued by it: that is settled before this claim is written, by
checking the token's issuer, signature and algorithm.

It is what makes `tcb_status` readable, because that value is in the
appraiser's own vocabulary.

### `tcb_status`

**Asserts** the appraiser's verdict about the platform's trusted computing
base, **in that appraiser's vocabulary**. The built-in appraiser answers
`unknown`, `ok` or `revoked-or-indeterminate`. Intel Trust Authority answers in
Intel's terms (`UpToDate`, `OutOfDate`, `SWHardeningNeeded`, …), reported
verbatim.
**Produced by** the appraiser, and for the delegated path from the token claim
the mapping names.
**Does not assert** a clean bill of health when it reads `unknown`: that value
means no collateral was consulted. A policy that treats `unknown` as acceptable
has decided to accept an unchecked TCB.

`revoked-or-indeterminate` folds two outcomes together because the vendor
libraries do: a revoked certificate and an unreadable CRL arrive as the same
answer.

### `collateral_checked`

**Asserts** whether vendor collateral — CRLs, TCB info — was consulted at all.
**Produced by** the appraiser. The built-in one consults none unless
`CheckRevocations` is set, so this is `false` by default.
**Does not assert** that the collateral was *current*. `false` means
`tcb_status` says nothing.

### `measurements`

**Asserts** the raw hardware registers the appraisal read, hex-encoded exactly
as the quote carries them: `tdattributes`, `mrtd`, `rtmr0`, `rtmr1`, `rtmr2`,
`rtmr3` on the TDX branches, `launch_digest` on SEV-SNP.
**Produced by** the quote itself, and on the delegated path cross-checked
against the registers the Verifier reported: every register the image identity
is computed from must agree, or the token is appraising a different TD.
**Does not assert** image identity. In particular **raw `rtmr0` is not a
reference value**: it accumulates the dynamic boot events of one VM, so it
differs between instances of the same release. The reference-value set is
`{tdattributes, mrtd, rtmr1, rtmr2, rtmr3}`, and the normalised value is
`mrenclave`.

Which members are populated depends on `platform`. On `tdx-azure` and
`snp-azure` these registers describe Microsoft's paravisor rather than the
sp-vm image, and the vTPM's PCR4 and PCR9 — where the image identity lives
there — are **not** surfaced in this object.

### `platform_security`

**Asserts** the report fields that describe how the VM was allowed to run:
`vmpl`, `debug_allowed`, `ciphertext_hiding`, `page_swap_disabled`,
`snp_firmware_tcb`, `report_version` and, when the chain names one,
`cpu_generation`.
**Produced by** the attestation report.
**Does not assert** that any of these values is acceptable. They are reported
and never judged — whether ciphertext hiding being off disqualifies a cloud is
the relying party's decision. `debug_allowed: true` means the host may decrypt
the guest; it is the one field whose bad value nobody sensibly tolerates, and
refusing it is still the policy's job.

## Image identity

### `mrenclave`

**Asserts** the normalised, vCPU-independent image identity:
`SHA-256(TDATTRIBUTES ‖ MRTD ‖ normalizedRTMR0 ‖ RTMR1 ‖ RTMR2 ‖ RTMR3)` on
TDX, and the rebuilt launch measurement on SEV-SNP.
**Produced by** replaying the RTMR0 event log the collection carries, down to
the firmware-identity events, and hashing the result with the other registers.
On SEV-SNP it is rebuilt from the published firmware of the build the VM claims.
**Does not assert** that anybody vouches for the image — that is
`mrenclave_approved`.

A quote-only Verifier never produces this claim: the event log is not something
it consumes, and it cannot practically be replayed in a policy language. That
is why the delegated appraiser replays it locally, and why a Verifier's result
alone is never sufficient evidence of image identity.

### `mrenclave_approved`

**Asserts** that something vouches for the image identity beside it.
**Produced by** asking Super Protocol's signed-measurement registry first and
the relying party's own reference values second.
**Does not assert** that the image is *appropriate* for the credential being
requested, nor that it is free of vulnerabilities.

`false` is a claim, not a failure: the registry answered, and the answer was
that this is not one of ours — which is what an unsigned or test build looks
like. Whether to
accept one is the policy's decision. When no image identity could be derived at
all, this claim and `mrenclave` are both **absent** — `false` would wrongly say
a set of reference values was consulted.

### `mrenclave_source`

**Asserts** what vouched for the image: `registry` is Super Protocol's
signature, checked against a key pinned inside the module; `reference-values` is
the relying party's own list.
**Produced by** the admission step. The registry is asked first, always, so an
image Super Protocol signed is reported as `registry` even when you also pinned
it. A reference-value match stands whether the registry said no or could not be
reached.
**Does not assert** equal weight for the two. `reference-values` proves strictly
less: that the VM ran an image whoever configured the verifier decided to
accept. Every hardware leg of the appraisal still had to pass.

### `spvm_build`

**Asserts** the sp-vm release the evidence *claims* the VM booted, for example
`build-476-release`.
**Produced by** the evidence, not by the hardware. It is what located the
artefacts a SEV-SNP measurement was rebuilt from.
**Does not assert** that the VM ran that build. It is producer-supplied and
proves nothing on its own; `mrenclave_approved` is what settles identity. A
build nobody published is still worth denying on, which is the fifth predicate
of the shipped policy.

## The membership chain

### `pki_root_fingerprint`

**Asserts** the `sha256/<base64url>` digest of the root the chain terminated
at — the DER of the certificate, SHA-256, unpadded base64url.
**Produced by** matching the chain's terminal certificate against the roots the
relying party pinned.
**Does not assert** that the root is *the* Super Swarm root; it asserts that it
is the one **you** pinned. A relying party that pins nothing denies everything
at the `pki-chain` stage, which is the intended behaviour.

### `pki_chain_ok`

**Asserts** that the certificate chain validated, leaf to root, and terminated
at a pinned root. The system trust store is never consulted.
**Produced by** the chain validation, before any evidence inside the chain is
appraised — until the chain holds, the certificates in it are attacker-supplied.
**Does not assert** revocation status of the member certificates.

### `root_quote_ok`

**Asserts** that the root certificate's own TEE evidence verified **and**
committed to that certificate's public key: the first 32 octets of its report
data are the SHA-256 of its SubjectPublicKeyInfo.
**Produced by** appraising the quote in the root's `0.6.9.42.840.113741.1337.6`
extension. On the delegated path this leg stays with the built-in offline
appraiser by default: the bank's Verifier appraises the per-request quote, and
the membership root is Super Swarm-specific.
**Does not assert** that the certificate authority is currently well operated —
only that its key was generated inside a measured confidential guest.

### `network_type`

**Asserts** what the root's `1.3.6.1.3.8888.4` extension declares about its own
network: `trusted` or `untrusted`.
**Produced by** the root certificate, and reported rather than enforced.
**Does not assert** a verdict. Super Protocol's own live Swarm stand is enrolled
as `untrusted`, which is why neither the core nor the shipped policy hard-codes
`trusted`: a deployment that has to admit such a root sets the required value in
its own configuration and writes down why.

## The signed statements

### `statement_ok`

*Composite form sets it from the leader's statement; the bundle form sets it
from the published JWS.*

**Asserts** that the statement's signature verified under a certificate that
chains to a pinned root.
**Produced by** trying every certificate in the membership bag that chains to a
pinned root until one verifies the signature — a signature only verifies under
the key that produced it — and recomputing the statement hash from the
statement in hand rather than trusting the signed copy.
**Does not assert** that the statement is about the request being appraised.
That is `envelope_ok`, and it is why no statement is appraised without one.

**A v1 gap worth knowing before you write a policy.** SwarmClaims v1 carries no
claim about what the signer's certificate itself proves. The appraisal accepts
any certificate in the membership bag that chains to a pinned root and verifies
the signature — including the node's own certificate — so the "the signer is
hardware-bound" predicate cannot be written against v0.1.0. The claim that will
carry it, `statement_signer_binding`, is tracked as SUP-697 and lands as an
additive `v0.y` minor before `v1.0.0`.

### `statement_signer_fingerprint`

**Asserts** the `sha256/<base64url>` digest of the certificate that verified the
statement's signature.
**Produced by** the same search.
**Does not assert** that this certificate is a per-leader signer rather than
some other leaf of the same PKI — see the gap above.

### `envelope_ok`

*Composite form.*

**Asserts** that the node's `NodeRequestEnvelope` verified under the certificate
it names, that the certificate chains to the pinned root, that its signed
`envelope_hash` is the hash of its own body, and that its `subject_hash`,
`freshness` and `target` are **this** request's.
**Produced by** verifying the envelope JWS and comparing its fields against the
request values the relying party is holding — not against the envelope's own
copy of them.
**Does not assert** anything about the workload beyond the pairing: it says the
node, which both authenticated the caller and produced the quote, vouches that
this request came from the pod the statement describes.

This is the claim that closes attester substitution. Without it, a workload in
an unlocked cluster space could take a quote over its own key and attach a
locked neighbour's published statement, and every other check here would still
pass.

### `node_cert_fingerprint`

*Composite form.*

**Asserts** the `sha256/<base64url>` digest of the node certificate the
membership chain was built for — the leaf that signed the envelope.
**Produced by** the validated chain.
**Does not assert** which physical host that is, or that the node is healthy.

### `gpu_attested`

*Composite form.*

**Asserts** that the verified envelope carries a GPU attestation token hash.
**Produced by** the envelope's `gpu_attestation_token_sha256`, and **never by
the quote**: the request-binding digest owns all 64 octets of the guest-chosen
field, so there is no room beside it to commit to a GPU token.
**Does not assert** that the GPU token is valid, current, or for the GPU this
workload used. Appraising the token itself is the relying party's business. A
token hash presented beside an envelope that did not verify leaves this claim
**unset**, not `false`.

## The pod the statement is about

These seven claims are what the leader signed. `statement_ok` is what makes them
readable; `envelope_ok: true` is what makes them this request's, and they are
never reported without it.

### `pod_uid`, `namespace`, `cluster_space_id`

**Assert** the pod's UID, its Kubernetes namespace, and the identifier of the
cluster space it runs in.
**Produced by** the leader's statement.
**Do not assert** that the names mean anything outside that cluster. They are
identifiers, not authorisations.

### `image_digests`

**Asserts** the set of container image digests the statement resolved —
containers and init containers together, sorted and de-duplicated.
**Produced by** the statement's `containers[].image_digest` and
`init_containers[].image_digest`, skipping any the producer could not resolve.
**Does not assert** that the list is complete: a container whose digest did not
resolve contributes nothing, so a short list is not evidence that nothing else
ran. An empty list means the statement resolved no digest at all, and the
shipped policy denies it for that reason. An init container has the same access
to the cluster space as any other, so approve both or deny.

### `locked`, `locked_at`

**Assert** whether the cluster space was locked when the statement was signed,
and when it was locked.
**Produced by** the leader's statement.
**Do not assert** that the space is locked *now*. An unlocked space can still
take new workloads, so what the statement says about this one stops being true
the moment after it was signed — which is the reason to require `locked: true`
rather than to reason about the window.

### `pss_enforce`

**Asserts** the Pod Security Standard level the namespace enforces, as a string:
`restricted`, `baseline` or `privileged`.
**Produced by** the statement's `pod_security.enforce`.
**Does not assert** that the pod itself is confined to that level at this
instant, only what the control plane enforced for the namespace. The value is
reported and never judged.

## Deployment evidence

### `evidence_digest`

*Bundle form.*

**Asserts** the digest of the canonical deployment snapshot a user pins.
**Produced by** the deployment evidence payload, when it carries one.
**Does not assert** anything in the composite form, where it is always absent.

## Refusals

### `denial`

**Asserts** that the evidence could not be appraised, with a `stage` and a
human-readable `reason`.
**Produced by** whichever leg refused. The claim set then carries nothing else
beyond `schema_version` and `freshness_input`.
**Does not assert** anything about the claims that are missing: they were not
checked and failed, they were not reached.

Only `stage` is machine contract — `options`, `blob`, `pki-chain`,
`root-quote`, `coverage`, `binding`, `envelope`, `statement`. `reason` is prose
for a human and its wording is not stable. What each stage means, and who
clears it, is in [`DENIAL-STAGES.md`](../DENIAL-STAGES.md).

One stage is worth singling out for a relying party: **`coverage` says nothing
about the evidence**. It means the configured Verifier does not cover this
attester's platform, and it is cleared by configuring a different appraiser, not
by investigating a node.
