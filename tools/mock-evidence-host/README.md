# mock-evidence-host

A TLS front for the router that publishes `/.well-known/swarm-evidence`, and
that can break what it publishes on demand.

In production the *platform* publishes a bundle for each router hostname, and
the router never learns whether anyone verified it (ADR-002). There is no
platform in a test, so this stands in for one: it terminates TLS with a
certificate it minted, serves a freshly signed bundle binding that exact
certificate, and reverse-proxies everything else to the router behind it.

**It attests nothing.** The TEE quote is a fixture blob and the root is minted
in-process. It exists so the evidence pipeline has something correctly shaped to
carry — not so anyone can conclude anything from what it carries.

## The deny paths are the point

A happy path is covered by a dozen unit tests. A gatekeeper only *proves* it is
fail-closed when something it trusted stops being trustworthy while traffic is
flowing, so every stage of the verification pipeline is reachable from here:

| Call | What it models | Stage that must refuse |
| --- | --- | --- |
| `rotateDeployment()` | a redeployment: new snapshot, new `evidenceDigest`, still perfectly signed | `policy` — until the new digest is pinned |
| `rotateCertificate()` | a certificate rotation the bundle follows | none: still attested, on a new channel |
| `breakChannelBinding()` | the bundle keeps claiming the old certificate | `tls-fingerprint` |
| `useOtherCloud()` | the chain re-terminates at a root the user never trusted | `untrusted-root` |
| `stopPublishing()` | the endpoint lost its publisher | `fetch` |
| `issuedAtSkewMs` | a bundle published stale, or dated in the future | `jws` |
| `restore()` | undoes all of the above | — |

`docs/threat-model.md` maps these onto T1–T4.

## Using it

```ts
import { startMockEvidenceHost } from '@confidential-router/mock-evidence-host';

const host = await startMockEvidenceHost({
  upstream: 'http://127.0.0.1:3000',   // the router this fronts
  hostname: 'localhost',               // the name the certificate carries
});

host.url;                 // https://localhost:<port> — an endpoint's `--upstream`
host.trustedRootPem;      // what a gatekeeper must `trust roots add`
host.evidenceDigest();    // what it publishes right now — the value to pin

await host.rotateDeployment();
await host.close();
```

`hostname` defaults to `localhost` because a test cannot edit `/etc/hosts`, and
the verifier compares `payload.hostname` with the host it fetched from.

As a process, with the deny paths exposed over HTTPS under `/__mock`:

```bash
MOCK_EVIDENCE_UPSTREAM=http://127.0.0.1:3000 \
MOCK_EVIDENCE_ROOT_FILE=./root.pem \
  pnpm exec tsx tools/mock-evidence-host/src/main.ts
```

```bash
curl -sk https://localhost:<port>/__mock/state
curl -sk https://localhost:<port>/__mock/rotate-deployment
curl -sk https://localhost:<port>/__mock/root.pem
```

The control surface is off unless `controlApi` is set. A real platform has no
such endpoint.

## Where the key material comes from

Two independent RSA PKIs — a trusted one and an "other cloud" — built from the
private keys in `@confidential-router/attestation-fixtures`, with certificates
**re-issued here** and a validity window centred on now.

That split is deliberate. The committed vectors are frozen in time: every case
pins `now: 2026-01-15` and the certificates expire on 2027-01-01. That is right
for a conformance suite and useless for a live endpoint, because a gatekeeper
checks the chain against the real clock — a server presenting those certificates
would start failing on a date nobody chose. Re-issuing from the same keys keeps
the material the repository already reviews and removes the expiry cliff.

The deployment snapshot and the TEE quote *are* taken verbatim from the vectors,
so what this publishes has the shape the conformance suite holds both verifiers
to.

## Tests

```bash
pnpm nx run @confidential-router/mock-evidence-host:test
```

They run the repository's own verifier (`@confidential-router/attestation`)
against the live TLS endpoint, with the leaf observed on the very connection the
bundle arrived over. A stand-in for the platform is only useful if what it
publishes is what the real pipeline accepts — and if each deny path fails at the
stage it claims to.

## Related

`docker/demo/evidence-publisher.mjs` is the compose stack's publisher: plain
HTTP, several endpoints at once, its own `openssl`-minted PKI, no controls. It
answers a different question (does the console render evidence on a laptop) and
is deliberately not this.
