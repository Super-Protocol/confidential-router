# `swarm-evidence-go`

The shared claim core for Super Swarm Evidence: one Go module that appraises
evidence offline and reports what it establishes as **SwarmClaims v1**.

```go
import swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"

claims, err := swarmevidence.AppraiseComposite(ctx, blob, swarmevidence.Options{
    Subject:        "llama-33-70b.tee.swarm.cloud",
    PKIRoots:       []attestation.TrustedRoot{{Name: "swarm-cloud-prod", PEM: rootPEM}},
    FreshnessInput: nonce,
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
| `options.go` | pinned PKI roots, reference values, the freshness input, the appraiser. |
| `appraise.go` | `AppraiseComposite`, and the mapping from pipeline stage to denial stage. |
| `quoteappraiser.go` | the `QuoteAppraiser` seam and the offline, built-in implementation. |
| `attestation/` | the `/.well-known/swarm-evidence` pipeline (its own README). |
| `attestation/attestedroot/` | is this certificate authority a Super Swarm one, decided from hardware. |
| `conformance/` | the harness that replays the shared vectors against any implementation. |

## What is appraised today

The **evidence bundle** form: a certificate chain, a compact JWS over a
deployment or control-plane statement, and the TEE evidence the chain's root
carries. That is what the fleet publishes and what the shared vectors pin.

The **composite** form — a hardware quote beside a node-signed
`NodeRequestEnvelope` and a control-plane statement, bound together by the
report-data digest of SUP-637 — is refused at the `blob` stage until SUP-638
settles its encoding and SUP-636 the statement. The claims it will fill in
(`binding_ok`, `envelope_ok`, `node_cert_fingerprint`, `gpu_attested`, the pod
claims) are declared in v1 already, so a policy can be written against the whole
contract before the second half lands.

Two limits worth knowing before writing a policy against `measurements`:

- On `tdx-azure` and `snp-azure` the hardware registers describe Microsoft's
  paravisor, not our image; the image identity is `mrenclave`, derived from the
  vTPM's PCR4 and PCR9 (`sp-vm/docs/08-azure-attestation.md`). The vendored
  `azurecvm` does not surface those two registers, so they are absent from
  `measurements` on the Azure branches — raising it upstream is the way to
  change that, not editing the vendored copy.
- Raw `rtmr0` is not usable as a reference value: it accumulates boot events.
  Reference values are `{tdattributes, mrtd, rtmr1, rtmr2, rtmr3}`, and the
  normalised value is `mrenclave`.

## Running the checks

```bash
pnpm nx run swarm-evidence-go:test     # go test ./...
pnpm nx run swarm-evidence-go:lint     # go vet ./... && golangci-lint run
pnpm nx run swarm-evidence-go:tidy     # go mod tidy
```

CI runs all of them in the `Go checks (gatekeeper)` job
(`.github/actions/go-checks`), on the module and on the gatekeeper, in that
order: a failure here explains a failure there.
