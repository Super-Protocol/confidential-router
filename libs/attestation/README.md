# `@confidential-router/attestation`

Framework-neutral verifier for the `/.well-known/swarm-evidence` contract. Given a
hostname, the TLS leaf the caller observed on its own connection, and a caller-managed
list of trusted roots, it decides whether the endpoint's published evidence is
authentic and bound to that connection.

This is the reference implementation of stages 1–6 of the gatekeeper pipeline
(ADR-003 §1). It is deliberately the *only* thing it does: it produces a verdict about
a bundle, never a policy decision (Rego, stage 7, is the Go gatekeeper's job) and never
a network side effect beyond the single evidence fetch.

Ported from swarm-cloud `libs/swarm-attestation` (BSL-1.1) with permission — see the
repository `NOTICE`. The Go verifier in `apps/gatekeeper/pkg/attestation` implements the
same algorithm and is held to the same conformance vectors.

## Usage

```ts
import { verifyHostname } from '@confidential-router/attestation';

const result = await verifyHostname({
  hostname: 'llama-33-70b.tee.swarm.cloud',
  // SHA-256 of the DER leaf seen on this process's own TLS handshake.
  observedTlsFingerprint: 'sha256/<base64url>',
  trustedRoots: [{ name: 'swarm-cloud-prod', pem: '-----BEGIN CERTIFICATE-----\n…' }],
  maxBundleAge: 24 * 60 * 60 * 1000,
});

if (result.ok) {
  // result.payload.evidenceDigest is what a user pins per endpoint.
  console.log(`signed under ${result.matchedRoot.name}`, result.payload);
} else {
  console.warn(`denied at stage ${result.stage}: ${result.reason}`);
}
```

`VerifyResult` is a discriminated union. On failure `stage` names the step that
rejected the bundle — `fetch`, `cert-chain`, `untrusted-root`, `jws` or
`tls-fingerprint` — and callers are expected to surface it verbatim; the gatekeeper's
503 body is `"<stage>: <reason>"`.

## The pipeline

| Stage | What must hold |
| --- | --- |
| `fetch` | `https://<hostname>/.well-known/swarm-evidence` answers 200 with a v1 bundle whose `hostname` is the one being verified. |
| `cert-chain` | `certChain` parses leaf → root, every certificate is inside its validity window at `now`, every issuer asserts `BasicConstraints.cA` (and `keyCertSign` when it declares a KeyUsage), `pathLenConstraint` is respected, each signature verifies against the next certificate, and the chain terminates at a self-signed root. |
| `untrusted-root` | The terminal root's SHA-256 DER fingerprint equals one of `trustedRoots`. Trust is by fingerprint, never by name or by parseability. |
| `jws` | The compact JWS verifies under the chain **leaf**'s key with `alg ∈ {RS256, ES256K}`, decodes to a recognised evidence payload, and that payload's `kind` and `hostname` agree with the envelope and the request. |
| `jws` (freshness) | With `maxBundleAge` set, `now − payload.issuedAt` is within the window, and no more than 60 s in the future (`ALLOWED_CLOCK_SKEW_MS`). Omitting `maxBundleAge` skips the check. |
| `tls-fingerprint` | `payload.certFingerprint` matches the channel. See below. |

### Channel binding

Two modes, reported back as `channelBinding`:

- **`observed`** — the caller passed `observedTlsFingerprint` from its own handshake.
  This is the strong binding and the only one the gatekeeper uses; `bundle.tlsLeaf` is
  ignored whenever an observed fingerprint is present.
- **`producer-asserted`** — no observed fingerprint, so the verifier hashes
  `bundle.tlsLeaf` instead. The producer asserts "this PEM is what I serve on TLS" and
  JWS-signs that assertion; it exists for surfaces without channel access. Anyone
  holding the signing key could lie, which is the same trust boundary as the rest of
  the bundle — but it is strictly weaker than `observed`.

Neither available is a failure, not a pass.

The `rootCaTeeQuote` is parsed and passed through **unverified**, for display only. A
`quoteVerifier` injection point is reserved for when TEE quote validation lands.

## Supported algorithms

| `alg` | Chain key | Implementation |
| --- | --- | --- |
| `RS256` | RSA-2048+ | Web Crypto (`jose` / `@peculiar/x509`). |
| `ES256K` | secp256k1 (`K-256`) | `@noble/curves`, always — see below. |

### Deviations from the swarm-cloud source

The swarm-cloud original tries Web Crypto for secp256k1 first and falls back to the
pure-JS verifier only when the call **throws**. That is not portable: under Node's
native Web Crypto, `@peculiar/x509`'s `verify()` swallows the "Unrecognized namedCurve"
error and returns a plain `false`, so a valid ES256K chain is silently rejected. The
swarm-cloud tests miss it because they install `@peculiar/webcrypto` as the global
crypto provider.

This port therefore routes **all** secp256k1 verification — certificate chain and JWS
alike — through `@noble/curves` on every runtime. Behaviour is then identical
everywhere, which is what a conformance-tested verifier needs; `valid-ec-deployment` in
the conformance suite covers it. The RSA path is unchanged and stays on Web Crypto.

Consumers must import this package statically (no lazy `import()` splits) so the
secp256k1 implementation is always present.

## Caching

`MemoryCache` is an optional TTL + LRU verdict cache. Keys cover the hostname, the
observed fingerprint (with a distinct slot for the producer-asserted path), a digest of
the trust store and `maxBundleAge`, so a permissive caller's verdict can never satisfy a
stricter one. Only successful verdicts are cached — a denial is always recomputed.

## Tests

`src/__tests__/conformance.spec.ts` replays every vector from
`@confidential-router/attestation-fixtures`; the rest cover what the wire contract
cannot express (argument validation, the cache, DER walking) plus the bundle-size
budget.

```
pnpm nx test attestation
pnpm nx typecheck attestation
pnpm nx lint attestation
pnpm nx build attestation
```

## Bundle-size budget

A browser build with every dependency inlined must stay under **200 KB gzipped**;
`src/__tests__/bundle-size.spec.ts` asserts it on every run rather than leaving it as
prose. Today it measures ~82 KB.
