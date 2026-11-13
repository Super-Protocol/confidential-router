# Denial stages

A refused appraisal returns `denial {stage, reason}`, and `stage` is the first
thing a relying party branches on: it decides whether the answer is "fix your
request", "this attester is not one of ours" or "retry later". This note is the
contract for that field, and it is written before `v1` is tagged because the set
is closed by the JSON Schema and cannot grow afterwards without a new version.

`TestDenialStagesAreDocumented` and `TestPipelineStageMappingIsPinned` hold the
code to what is written here.

## The seven stages

| `stage` | What it means | Who fixes it |
| --- | --- | --- |
| `options` | The appraisal was asked for without something it cannot proceed without: no `Subject` for a bundle, no `FreshnessInput` / `RequestTarget` / `RequestSubject` for a collection. | The caller. Nothing about the evidence was decided. |
| `blob` | The evidence is not a shape this module reads: not JSON, neither a CMW collection nor a `/.well-known/swarm-evidence` bundle, a collection version this build does not implement, a REQUIRED element missing, an element whose declared media type contradicts its type identifier. | The producer, or a version negotiation. |
| `pki-chain` | The certificate chain did not validate, or terminated at a root the relying party did not pin. | The producer, or the relying party's trust store. |
| `root-quote` | The hardware quote could not be appraised: absent, unreadable, not signed by the vendor, an appraiser that could not reach an answer. Both the membership root's own quote and the composite form's per-request quote deny here. | Depends on the reason; a registry that could not be consulted is retryable, a bad vendor signature is not. |
| `binding` | The evidence does not answer the request it was presented for: a report-data digest that is not this request's, or a channel binding that does not hold. | The producer, or a substituted request. |
| `envelope` | The node's `NodeRequestEnvelope` did not verify, or did not bind this request, this statement or this pod. | The producer, or an attester substitution. |
| `statement` | The leader's statement did not verify, is stale, or its signed hash is not the hash of the statement beside it. | The producer. |

Two stages are deliberately **not** in the set, and both are claims instead:

- An image nothing vouches for is `mrenclave_approved: false`, not a denial.
  Whether to accept an unsigned build is the relying party's policy, and a
  denial would make the reference-value mechanism unreachable. An appraiser
  that derived **no** image identity at all — which is every quote-only
  Verifier, since mrEnclave needs the RTMR0 event log replayed and normalised
  — reports neither claim: `false` would say a set of reference values was
  consulted. The identity is what the approval is about, so an approval with
  no identity beside it is left out too.
- A `network_type` the relying party dislikes is a reported claim. The live
  Swarm stand's root declares `untrusted`.

## What the bundle pipeline's stages fold into — and what is lost

The `/.well-known/swarm-evidence` pipeline (`attestation.Stage`, ADR-003 §1)
has its own vocabulary, named after the implementation. The claim set's
vocabulary is named after what a relying party reads it beside. The mapping is
therefore **lossy on purpose**, and this is the whole of it:

| `attestation.Stage` | `denial.stage` | What is lost |
| --- | --- | --- |
| `fetch` | `blob` | That the evidence never arrived, as against arriving malformed. A caller that must tell a dead endpoint from a bad one uses `attestation.VerifyHostname` directly, whose `Result.Unreachable` says so. |
| `cert-chain` | `pki-chain` | Nothing. |
| `untrusted-root` | `pki-chain` | That the chain was *sound* and merely terminated somewhere the relying party did not pin — the one failure an operator clears by adding a root rather than by fixing a producer. The reason text names the root's hex digest, which is what the operator needs. |
| `jws` | `statement` | Nothing. |
| `tls-fingerprint` | `binding` | That the binding which failed was to a TLS certificate rather than to a request. The two are different substitutions, and only the reason distinguishes them. |
| anything else | `blob` | Everything. This is the default arm, and it exists so that a pipeline stage added later cannot silently become a stage the schema does not declare. |

The composite form does not go through that pipeline and maps nothing: it
produces the claim set's stages directly.

## Why the reason is not parseable

`reason` is prose for a human reading a refusal. Only `stage` is machine
contract — and, in the shared conformance vectors, a `reasonContains`
substring, which is a deliberately weak pin so that improving the wording of a
message is not a breaking change.
