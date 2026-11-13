# `swarm-policy`

The relying party's decision about a Super Swarm credential request, as two
policy modules a bank's security team can read and diff:

| path | for |
| --- | --- |
| `rego/swarm_claims.rego` | OPA — Vault Community, or any OPA deployment |
| `sentinel/swarm-claims.sentinel` | Sentinel — Vault Enterprise |

Both take the same decision over the same document: a **SwarmClaims v1** claim
set, exactly as `libs/swarm-evidence-go` emits it
(`schema/swarmclaims.v1.schema.json`).

## Why this exists

The bank runs **one** Verifier, bought or built, and nothing Super
Swarm-specific may be required inside it. That Verifier appraises a hardware
quote and reports an EAT. Everything specific to Super Swarm — the membership
chain, the leader's workload statement, the node's request envelope, the image
identity derived from a normalised RTMR0 — is appraised by `swarm-evidence-go`
and reported as claims, and the decisions over those claims are taken **here**.

That split is the whole point. A quote-only Verifier's result is never
sufficient evidence of image identity, so something has to decide; putting
that something next to Vault, as a reviewable artefact, is what keeps the
bank's Verifier unmodified and swappable.

The claim core reports; the policy decides. `SwarmClaims` carries no verdict,
and neither module ships a decision Super Protocol took on a bank's behalf.

## The decision

Two groups, and the order matters.

**What must have been established.** An unverified quote, a quote that answers
somebody else's request, a chain that did not validate, a root whose own quote
did not hold, an image nothing vouches for, or a statement nothing binds to
this request — any of these makes every claim after it decoration. These are
checked first and are not configurable.

**The five predicates**, which are the bank's:

| predicate | claim | configuration |
| --- | --- | --- |
| `image ∈ approved` | `image_digests` | `approved_images` |
| `locked = true` | `locked` | — |
| `pss_enforce = restricted` | `pss_enforce` | `required_pss_enforce` |
| `network_type = trusted` | `network_type` | `required_network_type` |
| `spvm_build ∈ reference values` | `spvm_build` | `reference_builds` |

`network_type` is configuration rather than a constant for a reason worth
knowing: the live demonstration stand's PKI root declares `untrusted`, and a
deployment that has to admit the stand sets `required_network_type` there and
writes down why — rather than quietly deleting the check.

Every image digest the statement resolved must be approved, containers and
init containers alike, and a statement that resolved none denies: an init
container runs with the same access to the cluster space as any other.

## Reading an absent claim

**An absent claim was not established, and must deny.** Both modules read every
claim through a helper with a denying default, and this is not a style choice:

- In Rego, `input.quote_verified != true` is *undefined* when the claim is
  absent, an undefined expression makes the `deny` rule body fail, and the
  request is admitted. The policy reads `object.get(input, "quote_verified",
  false)` instead.
- In Sentinel, `claims.quote_verified` on an absent key is a runtime error,
  which is a policy that cannot be read rather than one that denies. The
  policy reads `claim("quote_verified", false)` instead.

`test_deny_an_absent_structural_claim` and
`test/swarm-claims/deny-an-absent-structural-claim.hcl` are the cases that fail
when either is written the short way.

An **explicit `null`** is the sibling trap, and the defaults do not catch it:
`object.get` and `claim()` substitute only for a member that is *missing*. A
document spelling `"image_digests": null` would make Rego's `count()` and
`some … in` undefined — both image rules fail, and the predicate passes — and
would make Sentinel's `length()` raise. Both modules therefore check the shape
before the contents (`is_array`, `types.type_of(…) is "list"`), covered by
`test_deny_an_explicit_null_image_digests` and
`test/swarm-claims/deny-a-null-image-digests.hcl`. This module's emitter never
writes that document, but a hand-assembled or relayed one can.

## Configuring it

**OPA.** `input` is the claim set; the bank's settings are `data.swarm.policy`.
`rego/data.json` is an example:

```sh
opa eval -d rego/swarm_claims.rego -d rego/data.json -I 'data.swarm.claims.allow' < claims.json
opa eval -d rego/swarm_claims.rego -d rego/data.json -I 'data.swarm.claims.deny' < claims.json
```

`deny` is a set of sentences explaining a refusal, so a denial is legible
without re-running anything.

**Sentinel.** `claims` is the claim set and the four settings are parameters,
which Vault Enterprise supplies from the policy's own configuration.

## Running the tests

```sh
go test ./...        # the Rego suite through OPA's tester, plus the checks below
sentinel test        # in sentinel/, with the Sentinel CLI
```

`go test` covers four things:

- **`TestRegoPolicy`** runs `rego/swarm_claims_test.rego` through OPA's own
  tester, so neither this repository's CI nor a bank's needs the `opa` binary.
- **`TestPolicyReadsOnlyClaimsTheSchemaPublishes`** holds every claim name the
  module reads against the published schema. A misspelt name in Rego is not an
  error — it is a policy that denies everything, which is only noticed in
  front of a real request.
- **`TestSentinelAndRegoCoverTheSamePredicates`** holds the two artefacts to
  each other, so one of them cannot quietly lose a check.
- **`TestSentinelPolicy`** runs the Sentinel suite when the CLI is on `PATH`,
  and skips otherwise. CI installs it.

Getting the Sentinel CLI locally:

```sh
curl -fsSLo sentinel.zip https://releases.hashicorp.com/sentinel/0.40.0/sentinel_0.40.0_linux_amd64.zip
unzip sentinel.zip -d ~/.local/bin
```

## Keeping it aligned

The input contract is `libs/swarm-evidence-go/schema/swarmclaims.v1.schema.json`.
A claim added there is available here the moment it is emitted; a claim
*renamed* there breaks `TestPolicyReadsOnlyClaimsTheSchemaPublishes`, which is
the point of that test. The denial stages a policy may see are documented in
`libs/swarm-evidence-go/DENIAL-STAGES.md` — `coverage` in particular means the
relying party's Verifier does not cover this attester's platform, which is
cleared by configuring a different appraiser rather than by investigating a
node.
