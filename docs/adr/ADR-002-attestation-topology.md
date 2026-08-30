# ADR-002 — Attestation topology

- **Status:** Accepted
- **Date:** 2026-08-30
- **Decided by:** Denis (decisions 2, 4, 9)

## Context

The product promise is "an LLM endpoint you can verify". Three hops carry a prompt:

```
user's app ──▶ Gatekeeper (user's machine) ──▶ Router (confidential cluster) ──▶ LiteLLM ──▶ model server
                                              └────────── same Swarm Cloud cluster space ──────────┘
```

Every hop could in principle publish its own evidence. Attesting each one separately would require the
gatekeeper to reach model backends that are not internet-facing, and the router to relay backend evidence
— which would turn the router into an attestation broker and violate the one architectural rule.

## The one architectural rule

**The router does not know when, whether, or by whom it is attested.** Verification happens on the user's
side, in the gatekeeper. The router *publishes* evidence and *meters* generations; it never receives,
stores, or displays a verification verdict. No gatekeeper registration, no instance list, no "verified"
badge anywhere in the router or its console.

## Decision

1. **Only the gatekeeper → router channel is attested.** The attested unit is a **router endpoint** = one
   public hostname of the router deployment (e.g. `llama-33-70b.tee.swarm.cloud`).
2. **The Swarm Cloud platform publishes the evidence, not the router.** The router is deployed in a
   locked Swarm Cloud cluster space. The platform's ingress-sync worker builds the canonical deployment
   snapshot of that namespace, signs a `DeploymentEvidence` JWS with a PKI leaf that chains to the
   TEE-attested cloud root, and serves the bundle at `https://<hostname>/.well-known/swarm-evidence`
   (see swarm-cloud `apps/swarm-cloud-api/src/app/workers/ingress-sync/ingress-sync-worker.service.ts`).
   The router process holds **no signing key** and cannot mint or alter evidence.
3. **The pinned value is `evidenceDigest`** — `sha256/<base64url>` of the canonical deployment snapshot
   JSON (`libs/evidence-signing/src/digest.ts` in swarm-cloud). Hex is accepted on input and normalised
   to the canonical form (ADR-003).
4. **Model backends are not attested separately.** LiteLLM and the model servers run in the *same*
   cluster space as the router, speak plain HTTP inside the cluster, and are therefore part of the same
   canonical snapshot: their container images, env and services are inside the digest the user pins. A
   changed backend image changes `evidenceDigest`, which the gatekeeper denies until the user re-pins.
   The trust boundary is the cluster space, not the router pod.
5. **Bundle contract** is swarm-cloud's unified `/.well-known/swarm-evidence` v1 (`version`, `kind:
   "DeploymentEvidence"`, `hostname`, `issuedAt`, `certFingerprint`, `jws`, `certChain[]`,
   `rootCaTeeQuote?`, `tlsLeaf?`); the JWS payload carries `evidenceDigest` and the `evidence` snapshot.
   Machine-readable form: `schemas/swarm-evidence-bundle.schema.json`.

## How the router knows its own endpoints and digests

The router must *list* its endpoints and what they publish (Overview / Models / evidence modal) without
ever judging them.

- **Endpoints come from config.** `router.yaml` → `endpoints[]` (`name`, `hostname`, operator-declared
  `tee` label, optional `evidenceUrl` override for clusters where the public hostname is not resolvable
  from inside). `models[]` reference an endpoint by name. Schema: `schemas/router-config.schema.json`.
- **Digests come from fetching its own bundle.** An `EvidencePoller` in `router-api` fetches
  `https://<hostname>/.well-known/swarm-evidence` for every configured endpoint on an interval
  (default 5 min) and on demand ("Fetch fresh quote" in the console). It:
  1. validates the bundle **shape** against the schema,
  2. **decodes** the JWS payload (base64url of the middle segment) **without verifying the signature**,
  3. stores an `EvidenceSnapshot` (raw bundle, `evidenceDigest`, `certFingerprint`, `issuedAt`,
     `rootCaTeeQuote.format`, flattened `containerImages[]`, terminal-cert subject, `fetchedAt`).
  Snapshots are idempotent on `(endpointId, evidenceDigest, certFingerprint, issuedAt)` so multiple
  replicas polling concurrently do not duplicate rows and no leader election is needed.
- The router deliberately does **not** run the verifier on its own bundle. Even a self-check would be a
  verdict, and rendering it would put a "verified" signal on the router's surface. Signature
  verification belongs to the user (gatekeeper) and to auditors (evidence export).

## How the console shows them

- **Overview / Models:** endpoint table — hostname, TEE label, enclave image digest(s) from the latest
  snapshot, an evidence badge whose only states are **Published** (a snapshot exists, `issuedAt` inside
  the freshness window), **Stale** (last snapshot older than the window) and **Not published**
  (no bundle fetched yet or fetch failed), plus tokens routed.
- **Evidence modal:** exactly what was published — platform (`rootCaTeeQuote.format`), image digests,
  quote age (`now − issuedAt`), measurement fields if the snapshot carries them, `evidenceDigest` (both
  encodings, with a copy button — this is the value users paste into the gatekeeper's `trustedEvidence`),
  `certFingerprint`, the certificate chain with each subject and the terminal root's SHA-256 fingerprint.
  Actions: **Copy evidence JWS**, **Fetch fresh quote** (re-poll). The prototype's "fingerprint match"
  row is rendered as two values side by side (published `certFingerprint`, and the fingerprint of
  `tlsLeaf` if present) — never as a match/mismatch verdict.
- **Gatekeeper page:** static explanation + downloads; no state.
- **Evidence coverage** metric (Overview, Activity) = generations whose endpoint had a fresh snapshot
  at generation time / all generations. A router-known fact ("did the platform publish a quote for
  this endpoint when I served this"), not a verdict.
- Wording rule for all surfaces: *published / signed / fresh / stale* — never *verified / trusted /
  attested by*.

## Consequences

- Rotating the platform PKI or the TLS certificate does **not** change `evidenceDigest`; users keep their
  pins. Changing anything in the namespace does, by design.
- The router works with or without a gatekeeper. Nothing in the request path checks for one.
- E2E/CI needs a **mock evidence publisher** (serves a fixture bundle on `/.well-known/swarm-evidence`)
  and a **mock LiteLLM** — both in `docker/` (SUP-84).
- The user has to review the canonical snapshot once (out of band, e.g. the console's evidence modal
  or an evidence export) before pinning its digest — pinning is explicit, never trust-on-first-use
  (ADR-003).
