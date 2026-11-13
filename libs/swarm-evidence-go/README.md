# `swarm-evidence-go`

The shared claim core for Super Swarm Evidence: one Go module that appraises
evidence offline and reports what it establishes as **SwarmClaims v1**.

```go
import swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"

// The composite form: one credential request's evidence.
claims, err := swarmevidence.AppraiseComposite(ctx, collection, swarmevidence.Options{
    PKIRoots:       []attestation.TrustedRoot{{Name: "swarm-cloud-prod", PEM: rootPEM}},
    FreshnessInput: handle,  // the 32-octet present-nonce Handle, verbatim
    RequestTarget:  target,  // the prepared Target octets, never recoded
    RequestSubject: cekpub,  // the DER SubjectPublicKeyInfo, never re-encoded
})
var denial *swarmevidence.Denial
if errors.As(err, &denial) {
    return fmt.Errorf("not appraisable at %s: %s", denial.Stage, denial.Reason)
}
```

It is a **separate Go module, Apache-2.0**, so a bank or a Veraison deployment
imports it without the router — which the BUSL repositories could not offer.
It lives next to the conformance vectors it must stay aligned with
(`libs/attestation-fixtures/vectors`), so there is no cross-repo vector sync.

## Why it exists

Three verifiers have to agree about the same evidence: the gatekeeper, the Intel
Trust Authority + Vault path (SUP-648) and the Veraison `super-swarm` scheme
(SUP-649). Written separately they would be three implementations that three
test suites have to keep in agreement. Written as adapters over
`AppraiseComposite` they agree structurally, and the only thing left to test is
each adapter's own translation.

`apps/gatekeeper/pkg/attestation` is the first of those adapters — a thin
consumer that re-exports the names the gatekeeper uses and nothing else.

## The core reports; the policy decides

`SwarmClaims` carries no predicate. Whether the image is in the approved set,
the cluster space is locked, the Pod Security Standard is `restricted`, the
network type is `trusted` or the sp-vm build is a reference value are all the
relying party's decisions, and taking them here would make the verdict
unarguable. What the core owes in exchange is two guarantees:

- **An absent claim was not established.** Only `schema_version` is always
  present. `mrenclave_approved: false` is a statement — the registry answered,
  and the answer was "not one of ours" — and is spelled differently from a claim
  nobody looked at.
- **A refusal is never a partial pass.** Evidence the core cannot appraise
  returns a `denial {stage, reason}`, and the claim set then carries nothing but
  that, `schema_version` and the `freshness_input` it was asked to bind.

`schema/swarmclaims.v1.schema.json` is the contract, shipped inside the module
because the policy, the EAR mapping and the vectors are written against it.
`TestClaimsMatchSchema` holds the schema and the Go struct to each other in both
directions, and `TestSchemaEnumsMatchConstants` does the same for every closed
set — a value the module can emit and the schema does not list would be a policy
falling through to its default.

## Layout

| path | what it is |
| --- | --- |
| `claims.go`, `schema/` | `SwarmClaims` v1 and its JSON Schema. |
| `options.go` | pinned PKI roots, reference values, the request values, the appraiser. |
| `appraise.go` | `AppraiseComposite`, form selection, and the pipeline-stage mapping. |
| `cmw.go` | the CMW collection parser, in both serialisations. |
| `composite.go` | the composite appraisal: binding, envelope, statement, pod claims. |
| `binding.go` | the TACRA binding preimage and its hash-by-field-size table. |
| `statement.go` | the two signed objects, and the JCS digest both are named by. |
| `quoteappraiser.go` | the `QuoteAppraiser` seam and the offline, built-in implementation. |
| `delegated.go` | the EAT-consuming appraiser for a relying party's own Verifier, and its claim mapping. |
| `eat.go` | authenticating an Attestation Results token: format, issuer, keys, algorithms. |
| `tokensource.go` | how a token is obtained — a live Verifier over HTTP, or a recorded one. |
| `DENIAL-STAGES.md` | what each `denial.stage` means, and the lossy pipeline mapping. |
| `attestation/` | the `/.well-known/swarm-evidence` pipeline (its own README). |
| `attestation/attestedroot/` | is this certificate authority a Super Swarm one, decided from hardware. |
| `conformance/` | the harness that replays the shared vectors against any implementation — verdicts, claim sets, and the composite corpus through every appraiser profile. |
| `internal/vectorgen` | the generator of the composite corpus in `libs/attestation-fixtures/vectors/composite`. |

## What is appraised

### The composite form

A **RATS Conceptual Message Wrapper collection** with four elements, as the
TACRA Vault protocol profile fixes it (`swarm-cloud/docs/specs/tacra-vault-profile.md`,
§"Evidence Format"):

| `type` | content | presence |
| --- | --- | --- |
| `swarm-quote` | the hardware quote, with the RTMR0 event log where the platform has one | REQUIRED |
| `swarm-pki-membership` | the PEM certificates each signature chains with | REQUIRED |
| `swarm-workload-statement` | the leader's statement about the requesting pod, a compact JWS | OPTIONAL |
| `swarm-node-request-envelope` | the node's `NodeRequestEnvelope v1`, a compact JWS | OPTIONAL |

**Both serialisations of that collection are read**: the profile's own
`{collection, v, elements[]}` object, and the standard CMW JSON collection of
`draft-ietf-rats-msg-wrap` — an object whose `__cmwc_t` member carries the
collection type and whose other members are CMW records, `[media-type,
base64url]`, keyed by the element type. The parse is of the collection as
such, not of a Super-Protocol-only container, because the relying party runs
one Verifier of its own choosing and a collection carrying the same parts must
appraise the same whoever produced or forwarded it. The two are held to the
same claim set by `TestAppraiseCompositeStandardWrapper`.

What it establishes, and what each step would otherwise leave open:

1. **The membership chain** validates to a root the relying party pinned, and
   that root's own TEE evidence verifies and commits to its key —
   `pki_chain_ok`, `pki_root_fingerprint`, `root_quote_ok`, `network_type`.
2. **The per-request quote** is appraised on its own platform's branch —
   `platform`, `quote_verified`, `tcb_status`, `measurements`, `mrenclave`,
   `spvm_build`.
3. **The binding digest**, `SHA-512(len32‖freshness ‖ len32‖target ‖
   len32‖subject)`, is recomputed locally and compared with the quote's
   guest-chosen field — `binding_ok`, `binding_subject_digest`. It is never
   compared with a value an intermediary reported, and the appraiser must say
   **which** field it read: on the Azure nested form the binding lives in the
   64-octet HCL user-data, because the hardware `REPORT_DATA` there is the
   paravisor's `SHA-256(runtime data JSON) ‖ 0³²` and is not guest-chosen at
   all.
4. **The node's request envelope** verifies under the certificate it names,
   that certificate chains to the pinned root, its signed `envelope_hash` is
   the hash of its own body, and its `subject_hash`, `freshness` and `target`
   are this request's — `envelope_ok`, `node_cert_fingerprint`.
5. **The leader's statement** verifies under a signer that chains to the
   pinned root, and its signed `statement_hash` is the hash of its own body —
   `statement_ok`, `statement_signer_fingerprint`, and the pod claims
   `pod_uid`, `namespace`, `cluster_space_id`, `image_digests`, `locked`,
   `locked_at`, `pss_enforce`.
6. **The pairing**: the envelope binds the statement in hand and the pod that
   statement is about. Without this a requester in an *unlocked* cluster space
   could take a quote over its own key and attach a locked neighbour's
   published statement, and every check in 1–5 would still pass. That is the
   draft's attester substitution, and element 4 is the only thing that closes
   it.

Three collections are legal and a fourth is not. Quote and membership alone
establish no pod claims; an envelope with nothing to pair carries no
`statement_hash` and says so; both together are the ordinary case. **A
statement with no envelope is refused at the `envelope` stage** — it is the
substitution shape itself. The consequence a policy author should hold on to:
**a pod claim is only ever reported beside `envelope_ok: true`**. `statement_ok`
and `envelope_ok` remain separate claims, because they answer different
questions, but neither being absent can leave a policy reading pod facts that
nothing binds to its request.

`gpu_attested` comes from the envelope's `gpu_attestation_token_sha256` and
never from the quote: the binding digest owns all 64 octets of the guest-chosen
field, so there is no room beside it to commit to a GPU token. A token hash
beside an envelope that did not verify leaves the claim **unset**.

### The evidence bundle form

The `/.well-known/swarm-evidence` contract: a certificate chain, a compact JWS
over a deployment or control-plane statement, and the TEE evidence the chain's
root carries. That is what the fleet publishes about a served hostname and what
the shared conformance vectors pin. It is about a hostname rather than a
request, so it establishes `channel_binding` and no request binding — an absent
claim was not established.

## Delegating the quote to the relying party's own Verifier

A bank runs **one** Verifier, bought or built, and will not deploy a second
one for Super Swarm. `DelegatedQuoteAppraiser` is the seam for that: it hands
the hardware quote to that Verifier, consumes the answer as an **EAT**, and
completes the appraisal here.

```go
appraiser := &swarmevidence.DelegatedQuoteAppraiser{
    AppraiserName: "intel-trust-authority",
    Tokens: &swarmevidence.HTTPTokenSource{
        URL:     "https://api.trustauthority.intel.com/appraise/v2/attest",
        Headers: map[string]string{"x-api-key": apiKey},
        Body:    map[string]string{"quote": "${quote_base64}"},
    },
    Token: swarmevidence.TokenVerification{
        Issuer: "https://portal.trustauthority.intel.com",
        Keys:   &swarmevidence.JWKSKeys{URL: "https://portal.trustauthority.intel.com/certs"},
    },
    Mapping: swarmevidence.ITAClaimMapping(),
}
```

**Nothing in it names a Verifier.** There is no ITA type, no ITA branch and no
ITA default: `ITAClaimMapping()` is one *value* of `ClaimMapping`, kept beside
the others rather than privileged. What an EAT calls a TD's registers is not
standardised — ITA emits `tdx_mrtd`, a Veraison EAR carries annotated evidence
with dots inside the claim names, Azure MAA uses `x-ms-*` — so the claim
paths, their encoding, the token format, the issuer and the verification keys
are all configuration. `TestSwappingTheVerifierIsConfigurationOnly` replays the
same quote through a second Verifier that reuses none of ITA's claim names,
encoding, issuer, algorithm or signing key, and requires the same claims out.

`ITAClaimMapping()` itself is written against Intel's published token
reference and held to it by `TestITAClaimMappingFindsIntelsPublishedClaims`,
which appraises a fixture built in the shape of Intel's sample. Three of those
names are a plausible guess away from denying every live appraisal —
`tdx_td_attributes` (not `tdx_tdattributes`), `attester_tcb_status` (not
`tdx_tcb_status`) and `tdx_report_data` (not `attester_held_data`, which is
the caller's own runtime data) — so the fixture carries the wrong-turn claims
beside the right ones. What no fixture can establish is that Intel's
documentation matches Intel's production tokens; only the live test against
the tenant of SUP-642 does that. `testdata/delegated/README.md` is explicit
about which is which.

### What stays here, and why

- **The binding digest.** The guest-chosen field is read out of the quote in
  hand, never out of the token. A Verifier that does not surface report data
  is therefore usable, and one that surfaces the wrong one cannot make a quote
  answer a request it does not answer.
- **The image identity.** `mrEnclave = SHA-256(TDATTRIBUTES ‖ MRTD ‖
  normalizedRTMR0 ‖ RTMR1 ‖ RTMR2 ‖ RTMR3)` needs the RTMR0 event log, which
  no quote-only Verifier consumes and which Rego cannot practically replay. A
  Verifier's result alone is never sufficient evidence of image identity.
- **Who vouches for it.** The signed-measurement registry and the relying
  party's reference values are consulted through the same code the offline
  path uses, so the two cannot drift in what they accept.
- **The membership root's own quote**, which goes to `RootAppraiser` — the
  built-in offline appraiser by default. The bank's Verifier appraises the
  per-request quote; the root's quote is part of the membership chain, which
  is Super Swarm-specific and therefore ours.

### Binding the token to the quote

Every register the mrEnclave formula consumes is read from the token *and*
from the quote, and they must agree — a token appraising some other TD
disagrees about at least one of them.

That covers the registers and not the report data, so the report data is
covered separately, by `TokenSource.SubmitsEvidence`. A source that submits
these exact octets to the Verifier (`HTTPTokenSource`) binds the token
structurally. A source that **relays** a token (`RecordedTokens`, or an
attester carrying its own) does not, and the appraiser then requires
`ClaimMapping.BindingData` to be configured and checks the token's report data
against the quote's — because otherwise a holder of any genuine token could
pair it with a quote blob carrying the same registers and a report data they
chose.

### Coverage

The delegated path appraises `tdx-qemu` and `tdx-gcp`. Everything else is a
`denial` at the **`coverage`** stage naming the limitation, never a partial
verdict: a SEV-SNP launch measurement is rebuilt from published firmware
rather than reported by a quote-only Verifier, and on either Azure branch the
hardware measurement describes Microsoft's paravisor while the image identity
lives in vTPM `PCR4`/`PCR9`. `coverage` is its own stage because it says
nothing about the evidence — what clears it is a different appraiser, not a
different node (`DENIAL-STAGES.md`).

### The policy that goes with it

`libs/swarm-policy` carries the OPA and Sentinel modules that decide over
`SwarmClaims`. That is deliberately where all Super Swarm-specific appraisal
lives, and it is what keeps the bank's single Verifier unmodified.

### Two limits worth knowing before writing a policy against `measurements`

- On `tdx-azure` and `snp-azure` the hardware registers describe Microsoft's
  paravisor, not our image; the image identity is `mrenclave`, derived from the
  vTPM's PCR4 and PCR9 (`sp-vm/docs/08-azure-attestation.md`). The vendored
  `azurecvm` does not surface those two registers, so they are absent from
  `measurements` on the Azure branches — raising it upstream is the way to
  change that, not editing the vendored copy.
- Raw `rtmr0` is not usable as a reference value: it accumulates boot events.
  Reference values are `{tdattributes, mrtd, rtmr1, rtmr2, rtmr3}`, and the
  normalised value is `mrenclave`.

## The vectors are the contract

Two corpora in `libs/attestation-fixtures/vectors` decide what this module
must establish, and both are replayed from here:

| corpus | what it pins | harness |
| --- | --- | --- |
| `manifest.json` | the `/.well-known/swarm-evidence` bundle form: a verdict **and** a `SwarmClaims` document per case | `conformance.Run`, `conformance.RunClaims` |
| `composite/manifest.json` | the composite form: a `SwarmClaims` document per case, replayed through every appraiser profile | `conformance.RunComposite` |

Three things follow from pinning the whole claim set rather than a verdict:

- **A path that disagrees on one field fails.** Two implementations that
  agreed on "appraisable" and disagreed on `locked` would both pass a
  verdict-shaped corpus and hand a bank's policy two different answers.
- **The appraiser is configuration.** The composite corpus declares two
  EAT-emitting profiles whose claim names, octet encodings, issuers and
  signing keys all differ, and both must produce the claim set the recorded
  offline appraisal produces — the only claim allowed to differ is
  `quote_appraiser`, which names the appraiser. Nothing in this module names
  either profile.
- **Coverage is asserted, not described.** A profile that cannot appraise a
  case's platform returns a typed denial, and the case says so. That is how
  "the stand-in Verifier covers bare-metal and GCP TDX" stops being a footnote.

What the corpus does not cover is the vendor signature itself: no fixture can
carry a TDX or SEV-SNP signature over a request this repository invented, so
the quote appraisal is recorded and everything downstream of it is pinned.
That half is covered against real recorded evidence in
`attestation/attestedroot`.

```bash
pnpm nx run swarm-evidence-go:generate-vectors   # regenerate the composite corpus
```

Regenerating must be a no-op; CI fails on a diff. Adding a case, and
recording a token from a real Verifier, are documented in
`libs/attestation-fixtures/README.md`.

## Versioning and release tags

This is a Go module in a subdirectory, so its tags carry the subdirectory
prefix the toolchain requires:

```
libs/swarm-evidence-go/vX.Y.Z
```

`go get github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go@v1.2.3`
resolves that tag; a bare `vX.Y.Z` tag on this repository belongs to the
router and must never be read as a release of this module.

The convention, for CTO sign-off before the first external consumer:

- **`v0.y.z` until SUP-648 and SUP-650 land.** They are the first two users of
  the claim set from outside the gatekeeper, and `v1.0.0` should mean "the
  contract survived contact with them", not "PR 2 merged".
- **`SwarmClaims` has its own version**, `schema_version`, and it is **not**
  the module's. A module release may fix a verification bug without touching
  the claim set, and a claim set version may only change with the schema.
  `v1.0.0` of the module will ship `schema_version: "1"`.
- **A tag is cut from `main` only**, after the `Go checks (gatekeeper)` job is
  green on it, and its message names the issue that justified it.
- **The schema is the compatibility surface.** Adding an optional claim is a
  minor release; removing one, narrowing a pattern, or adding a value to a
  closed enum is a new `schema_version` and a major release, because a policy
  matching on these strings literally would fall through to its default.

## Running the checks

```bash
pnpm nx run swarm-evidence-go:test     # go test ./...
pnpm nx run swarm-evidence-go:lint     # go vet ./... && golangci-lint run
pnpm nx run swarm-evidence-go:tidy     # go mod tidy
```

CI runs all of them in the `Go checks (gatekeeper)` job
(`.github/actions/go-checks`), on the module and on the gatekeeper, in that
order: a failure here explains a failure there.

`golangci-lint` must be a build whose own Go is at least this module's `go`
directive; an older one refuses to load the config rather than running with
fewer checks.
