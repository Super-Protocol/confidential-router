# `@confidential-router/attestation-fixtures`

Language-neutral conformance vectors for the `/.well-known/swarm-evidence` verifier.

The vectors are the contract. Every implementation — the TypeScript
`@confidential-router/attestation` and the Go `apps/gatekeeper/pkg/attestation` — must
produce the same verdict for every case. A verifier that passes its own unit tests but
not these has drifted.

The TypeScript loader in `src/` is a convenience wrapper, not the contract: Go embeds
the same JSON files with `go:embed` and reads them directly.

## Layout

```
vectors/
  manifest.json           the cases
  roots.json              the trust anchors cases refer to by name
  evidence-digest.json    accepted/rejected spellings of a pinned evidenceDigest
  bundles/<case-id>.json  the document each case's evidence endpoint serves
```

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

### `evidence-digest.json`

Spellings of a pinned `evidenceDigest` that must be accepted (with their canonical
`sha256/<base64url>` form) or rejected. `canonicalFinalCharacters` records the only 16
base64url characters a 32-byte digest can end with: 43 characters carry 258 bits, so the
last one must have its two trailing bits clear. Accepting the other 48 would admit
several spellings of the same bytes, and pins are compared as exact strings.

Consumed by `@confidential-router/types` (`normalizeEvidenceDigest`) and by the Go pin
loader in `apps/gatekeeper/pkg/config`.

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
pnpm nx run attestation-fixtures:generate
```

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
