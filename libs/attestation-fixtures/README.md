# `@confidential-router/attestation-fixtures`

Language-neutral conformance vectors for the `/.well-known/swarm-evidence` verifier.

The vectors are the contract. Every implementation — the TypeScript
`@confidential-router/attestation` and the Go `libs/swarm-evidence-go/attestation` — must
produce the same verdict for every case. A verifier that passes its own unit tests but
not these has drifted.

The TypeScript loader in `src/` is a convenience wrapper, not the contract: Go embeds
the same JSON files with `go:embed` and reads them directly.

## Layout

```
vectors/
  manifest.json              the bundle cases
  roots.json                 the trust anchors cases refer to by name
  evidence-digest.json       accepted/rejected spellings of a pinned evidenceDigest
  root-quote-appraisal.json  the recorded root-quote appraisal the claim sets are written against
  bundles/<case-id>.json     the document each case's evidence endpoint serves
  composite/                 the composite-evidence corpus (see below)
    manifest.json            the appraiser profiles and the cases
    roots.json               the trust anchors those cases pin
    collections/<id>.json    the CMW collection each case presents
    appraisals/<id>.json     the recorded quote appraisal, neutral and as tokens
```

There are two corpora, for the two forms of Super Swarm evidence. The bundle
corpus is the `/.well-known/swarm-evidence` contract a hostname publishes; the
composite corpus is the CMW collection one credential request presents. Both
pin a `SwarmClaims` document per case, and the composite one additionally
replays every case through every appraiser profile.

### `roots.json`

```jsonc
{
  "version": "1",
  "roots": [
    {
      "name": "confidential-router-test-root-rsa",
      "fingerprint": "sha256/<base64url>", // SHA-256 of the DER — what a verifier matches on
      "pem": "-----BEGIN CERTIFICATE-----\n…"
    }
  ]
}
```

### `manifest.json`

`referenceNow` is the instant every certificate validity window is centred on. Each
entry of `cases[]`:

| Field | Meaning |
| --- | --- |
| `id` | Unique; also the bundle filename. |
| `description` | What the case is about, in one sentence. |
| `request.hostname` | The hostname to verify. |
| `request.trustedRoots` | Names into `roots.json`. An empty array means an empty trust store. |
| `request.observedTlsFingerprint` | The live-channel fingerprint. **Absent** selects the producer-asserted binding mode. |
| `request.now` | The instant to evaluate at — freshness and certificate validity are deterministic because of it. |
| `request.maxBundleAge` | Freshness window in milliseconds. **Absent** means the freshness stage is skipped. |
| `response` | What `https://<hostname>/.well-known/swarm-evidence` answers: a `status`, plus exactly one of `bodyFile` (a path under `vectors/`, served verbatim as `application/json`) or `bodyText` (a literal, non-JSON body). |
| `expect` | The verdict. |

A verifier must reach for that URL and no other; the reference fetcher
(`makeCaseFetcher`) throws on any other request.

`expect` on success:

```jsonc
{
  "ok": true,
  "kind": "DeploymentEvidence",
  "channelBinding": "observed",          // or "producer-asserted"
  "matchedRoot": "confidential-router-test-root-rsa",
  "payload": { /* the decoded JWS payload, compared member by member */ },
  "rootCaTeeQuote": { /* present only when the bundle carries one */ }
}
```

`expect` on failure:

```jsonc
{
  "ok": false,
  "stage": "untrusted-root",             // fetch | cert-chain | untrusted-root | jws | tls-fingerprint
  "reasonContains": "not in trusted store"
}
```

Only `stage` and `reasonContains` are normative. Full reason strings are deliberately
**not** pinned — wording is allowed to differ between implementations, the stage and the
substring are not.

Every case additionally carries `expect.claims`: what the **claim core**
(`libs/swarm-evidence-go`) must establish, which is a different assertion from
the verdict beside it.

```jsonc
"claims": {
  "ok": false,
  "stage": "root-quote",                 // the claim set's vocabulary, not the pipeline's
  "reasonContains": "not readable",
  "document": { "schema_version": "1", "denial": { "stage": "root-quote" } }
}
```

`document` is the whole `SwarmClaims` document and is compared member by
member. Two members are not compared literally: `quote_appraiser` is written
as the placeholder `<appraiser>` and resolves to whichever appraiser replayed
the case, and a denial's `denial.reason` is dropped before the comparison, for
the same reason full reason strings are not pinned anywhere else here.

A verdict and a claim set are not the same assertion, and three cases show it:
`valid-ec-deployment`, `valid-ec-deployment-high-s` and `valid-ec-chain-high-s`
are sound bundles whose claim set is a denial, because the claim core reads the
root's public key to check that its TEE evidence commits to it and `crypto/x509`
has no secp256k1 parser. A corpus that pinned only verdicts would have left that
difference to a comment.

The claims are written against `root-quote-appraisal.json`, a recorded
appraisal of the membership root's own TEE evidence. No fixture can carry a
vendor signature over a certificate this repository minted, so the quote
appraisal is held fixed and what the corpus pins is everything downstream of
it; the vendor-signature half is covered against real recorded evidence in
`libs/swarm-evidence-go/attestation/attestedroot`.

### `evidence-digest.json`

Spellings of a pinned `evidenceDigest` that must be accepted (with their canonical
`sha256/<base64url>` form) or rejected. `canonicalFinalCharacters` records the only 16
base64url characters a 32-byte digest can end with: 43 characters carry 258 bits, so the
last one must have its two trailing bits clear. Accepting the other 48 would admit
several spellings of the same bytes, and pins are compared as exact strings.

Consumed by `@confidential-router/types` (`normalizeEvidenceDigest`) and by the Go pin
loader in `apps/gatekeeper/pkg/config`.

## The composite corpus

`vectors/composite/` pins the other form: a RATS Conceptual Message Wrapper
collection carrying the hardware quote, the PKI membership chain, the leader's
workload statement and the node's request envelope, appraised into
`SwarmClaims` for **one credential request** (SUP-638, SUP-636, SUP-637).

### A case

```jsonc
{
  "id": "composite-full-tdx-qemu",
  "description": "…",
  "request": {
    "freshnessInput": "5a5a…",                       // hex, verbatim, the Freshness Kind's size
    "target": "aHR0cHM6Ly92YXVsdC…",                 // unpadded base64url, prepared Target octets
    "subject": "MFkwE0NFS3B1Yi…",                    // unpadded base64url, DER SubjectPublicKeyInfo
    "trustedRoots": ["swarm-cloud-conformance-root"],
    "now": "2026-01-15T12:00:00.000Z",
    "maxEvidenceAge": 60000,                         // optional, milliseconds
    "referenceValues": ["5c5c…"]                     // optional, the relying party's own
  },
  "evidenceFile": "composite/collections/composite-full-tdx-qemu.json",
  "appraisalFile": "composite/appraisals/composite-full-tdx-qemu.json",
  "expect": {
    "ok": true,
    "claims": { /* the whole SwarmClaims document */ },
    "appraisers": {                                  // optional per-profile overrides
      "ita-stand-in": { "ok": false, "stage": "root-quote", "reasonContains": "…", "claims": { … } }
    }
  }
}
```

An absent `appraisers` entry is the point of the corpus: **the claim set may
not depend on which appraiser produced it**, beyond the `quote_appraiser`
claim that names it. An entry is a coverage statement — this Verifier cannot
appraise this evidence, and must say so with a typed denial rather than a
partial verdict.

### Appraiser profiles

`manifest.json` declares the appraisers every case is replayed through:

| profile | what it is |
| --- | --- |
| `recorded-offline` | the appraisal read straight out of the fixture, in the claim set's own spelling — the offline built-in appraiser's stand-in |
| `ita-stand-in` | an EAT-emitting Verifier: flat Intel-flavoured claim names, hex octets, its own issuer and signing key, Intel TDX on bare metal and GCP only |
| `second-verifier` | a second EAT-emitting Verifier: nested claim names that share none of the first's, base64url octets, a different issuer and a **different signing key**, all five platforms |

The second profile is what makes the swap acceptance of SUP-648 checkable
rather than asserted: a fake that reused the stand-in's claim names and key
would only show the same decoder running twice. Everything that distinguishes
the two — token format, issuer, verification key, claim paths, octet encoding
— is data in `manifest.json`, and no implementation names either of them.

```jsonc
{
  "name": "second-verifier",
  "kind": "eat",
  "tokenFormat": "jwt",
  "issuer": "https://verifier.bank.example/eat",
  "verificationKey": { "kid": "bank-verifier-2026", "pem": "-----BEGIN PUBLIC KEY-----…" },
  "octetEncoding": "base64url",
  "claimNames": { "mrtd": "appraisal.measurement.mrtd", … },   // dotted paths
  "platforms": ["tdx-qemu", "tdx-gcp", "tdx-azure", "snp-qemu", "snp-azure"],
  "outsideCoverage": { "stage": "root-quote", "reason": "…" }
}
```

### What is recorded, and what that does not cover

`appraisals/<case>.json` holds two appraisals — the membership root's own
quote and the per-request quote — in the neutral spelling, and the same two
re-encoded as a signed token per EAT profile. An empty token means the profile
does not cover that half's platform.

What is recorded is **the EAT shape the adapter consumes, not any one
Verifier's wire format**. Intel Trust Authority is the stand-in on the
demonstration stand and not the target architecture (CTO, 2026-11-13); a
corpus written against its wire format would have to be rebuilt the day it is
replaced.

The limit worth stating plainly: no fixture can carry a TDX or SEV-SNP
signature over a request this repository invented, so the quote appraisal is
held fixed and the corpus pins everything downstream of it — the binding, the
chain, the envelope, the statement, the pairing and the claim set. The
vendor-signature half is covered where real recorded evidence exists, in
`libs/swarm-evidence-go/attestation/attestedroot`.

### Coverage

30 cases: all five platforms, both serialisations of the collection, the three
legal collections and the fourth that is refused, an image identity that is
approved / unapproved / admitted by reference values / absent altogether, a
GPU token hash, an unlocked cluster space and a `privileged` Pod Security
Standard — both claims rather than denials — and the threat list: wrong
target, replayed nonce in the quote and in the envelope, modified CEKpub, a
foreign envelope subject and a foreign envelope target, an envelope signed by
a foreign node certificate, a statement signed outside the pinned PKI, a chain
to another PKI root, **a statement about another pod attached to this quote**,
a statement with no envelope, a GPU token beside an envelope that does not
verify, an event log that does not replay to the quote's RTMR0, and evidence
older than the caller accepts.

Two of those deserve their own note:

- *a statement about another pod attached to this quote* is the attester
  substitution the `NodeRequestEnvelope` exists to catch. Every other check in
  the case passes.
- *`locked: false`* and *`pss_enforce: privileged`* are **not** denials. The
  core reports; the policy decides, and a corpus that denied them would make
  the predicate mechanism unreachable.

## Coverage

31 cases: every evidence `kind`, both channel-binding modes, `maxBundleAge` present and
absent, an RSA/RS256 chain and a secp256k1/ES256K one, both halves of the secp256k1 `S`
(see below), and at least three failures per verifier stage — HTTP error, non-JSON body,
replayed hostname, malformed envelope, expired certificate, spliced chain, non-CA
intermediate, chain that never reaches a self-signed root, untrusted/absent trust
anchor, forged and unsupported JWS, stale and future-dated payloads, and every way
channel binding can fail.

### High-S secp256k1 signatures

`(r, s)` and `(r, n − s)` are both valid ECDSA signatures over the same message, and
neither RFC 7515 (`ES256K`) nor X.509 requires the low-half form. A producer that does
not normalise S — OpenSSL, notably — emits the high one about half the time, so a
verifier that rejects it would deny roughly half of all genuine K-256 bundles. Two
vectors pin the accepting behaviour, kept orthogonal so a failure names the code path:

| Case | High-S where | Everything else |
| --- | --- | --- |
| `valid-ec-deployment-high-s` | the ES256K JWS signature | the `confidential-router-test-root-ec` chain, low-S |
| `valid-ec-chain-high-s` | all three certificate signatures of the `confidential-router-test-root-ec-high-s` chain — leaf, intermediate, root self-signature | the JWS, low-S |

`@noble/curves` signs low-S unconditionally, so the generator negates S after signing;
the high-S PKI shares its key material with the low-S one on purpose — only the encoding
of the signatures differs.

## Regenerating

```
pnpm nx run attestation-fixtures:generate     # the bundle corpus and its claims
pnpm nx run swarm-evidence-go:generate-vectors # the composite corpus
```

The second one is a Go program
(`libs/swarm-evidence-go/internal/vectorgen`), because the composite corpus
needs the module's own element identifiers and the JCS digest its signed
objects are named by. Both write into `vectors/`, neither touches the other's
files, and CI fails if re-running either is not a no-op.

The generator is run directly by Node (`node tools/generate.ts`) and relies on
type stripping, which is on by default from Node 22.18 — hence the workspace's
`engines.node`. `.nvmrc` pins Node 24.

Output is deterministic: the key material under `tools/keys` is fixed, so are all serial
numbers, validity windows and timestamps, and both signature schemes are deterministic —
RSASSA-PKCS1-v1_5 by construction, secp256k1 because `@noble/curves` derives `k` per
RFC 6979. `crypto.subtle`'s own ECDSA is *not* deterministic, so the generator routes EC
signing through noble.

Running the generator twice produces byte-identical files. **A non-empty `git diff` after
a run therefore means a real change to the contract** — review it as one, and re-run the
Go verifier's suite before merging.

> The private keys under `tools/keys` are throwaway test material committed on purpose so
> the vectors are reproducible. They protect nothing.

## Adding a case

Cases are never hand-written into `vectors/` — both corpora are generated, and
CI fails when regenerating them is not a no-op. A hand-edited expectation is
also the one way a corpus stops asserting anything: it ends up fitted to
whatever the code happens to do.

**A bundle case** goes into `tools/generate.ts`, as one more `addCase({…})`
beside the stage it belongs to. Its `expect.claims` is derived centrally by
`claimsFor`, so a new case needs nothing beyond its verdict — unless it is a
case whose *claim set* differs in a new way, which is a deliberate edit to
`claimsFor` and should be reviewed as one.

**A composite case** goes into `cases()` in
`libs/swarm-evidence-go/internal/vectorgen/cases.go`, declared as the
differences from a sound appraisal:

```go
{
    id:          "composite-deny-envelope-foreign-target",
    description: "…what the case is about, in one sentence…",
    platform:    swarmevidence.PlatformTDXQemu,
    envelope:    func(e map[string]any) { e["target"] = b64([]byte("https://…")) },
    denyStage:   "envelope",
    denyReason:  "envelope target",
}
```

Everything the case does not mention is the canonical case, so the denial is
attributable to exactly one broken fact. A case that is appraisable declares
no `denyStage`, and its claim set is assembled by `expectation` from the facts
the case itself declares — the recorded appraisal, the certificates, the
statement. Then:

```
pnpm nx run swarm-evidence-go:generate-vectors
pnpm nx run swarm-evidence-go:test
```

Review the generated diff as a change to the contract. Both suites that read
the corpora (`libs/swarm-evidence-go`, and this project's `vitest` specs) must
pass before it is a vector.

## Recording a Verifier token

The EAT fixtures are minted by the generator from the committed keys
`tools/keys/eat-*.key.pem`, so the corpus runs offline in CI. Recording a
**real** token — against the Intel Trust Authority tenant of SUP-642, or
against whichever Verifier replaces it — is the same shape of work:

1. Submit the case's quote to the Verifier and keep the raw response. For ITA
   that is `POST /appraisal/v2/attest` with the quote and the runtime data;
   the response is a JWT signed by a key published at the tenant's JWKS URL.
2. Map its claims onto the appraisal the corpus records — platform, verified,
   TCB status, the measurement registers, the guest-chosen field and which
   field it was read from. **Record the EAT shape the adapter consumes, not
   the Verifier's wire format**: the stand-in is replaceable, and a corpus
   written against one product's spelling has to be rebuilt when it is.
3. Add the Verifier as an appraiser profile in `composite/manifest.json`
   (through the generator): its issuer, the verification key or `kid` from its
   JWKS, the claim paths, the octet encoding, and the platforms it covers.
   Nothing about it may need code — if it does, that is the finding, not the
   configuration.
4. Regenerate, and expect the same claim sets as every other profile. A case
   the new Verifier cannot appraise gets an `expect.appraisers` entry naming
   the typed denial, which is how the coverage difference stays asserted.

The live test against a real tenant stays **manual** until the tenant owner is
named (SUP-642); CI runs on the recorded tokens, which is why they are
committed.
