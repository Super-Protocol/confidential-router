import { createHash, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import type { CertificateSummary, EvidenceWorkloadSummary } from '../db/entities/evidence-snapshot.entity.js';
import { type EvidenceDigest, EvidenceDigestError, parseEvidenceDigest } from './evidence-digest.js';

/**
 * Reads a published `/.well-known/swarm-evidence` bundle into the fields an
 * `EvidenceSnapshot` row keeps.
 *
 * **This is not a verifier and must never become one** (ADR-002, "the one
 * architectural rule"). It validates the bundle's *shape*, decodes the JWS
 * payload — base64url of the middle segment, signature untouched — and copies
 * out what the console renders. Whether the signature is good, whether the chain
 * terminates at a root anyone trusts, and whether the TLS fingerprint matches
 * the live channel are the user's gatekeeper's questions; answering any of them
 * here would put a verdict on the router's surface.
 *
 * That is also why it does not import `@confidential-router/attestation`: the
 * verifier is one import away from being called, and the shape contract
 * (`schemas/swarm-evidence-bundle.schema.json`) is small enough to mirror.
 */

const FINGERPRINT = /^sha256\/[A-Za-z0-9_-]{43}$/;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Mirror of `schemas/swarm-evidence-bundle.schema.json`; unknown members pass through. */
const BundleSchema = z.looseObject({
  version: z.literal('1'),
  kind: z.enum(['DeploymentEvidence', 'ControlPlaneEvidence', 'KubernetesControlPlaneEvidence']),
  hostname: z.string().min(1),
  issuedAt: z.iso.datetime({ offset: true }),
  certFingerprint: z.string().regex(FINGERPRINT),
  jws: z.string().regex(COMPACT_JWS),
  certChain: z.array(z.string().min(1)).min(1),
  /**
   * Passed through unread, in the spirit of the Go verifier, which keeps it as
   * a `json.RawMessage` and never inspects it. A shade looser, in fact: both
   * verifiers still require the member to be an object when it is present, and
   * this accepts anything, because nothing here can act on the difference.
   *
   * `schemas/swarm-evidence-bundle.schema.json` requires `format` and `data`
   * here, so a producer that publishes neither is out of spec — but the only
   * thing this router does with the member is print `format` beside the digest,
   * and a display field must not be able to reject a bundle. Mirroring the
   * schema strictly is what made the console report "Not published" for an
   * endpoint a gatekeeper was admitting at the same moment (SUP-157), because
   * the platform publishes `{ "status": "not-implemented" }` until the root CA
   * quote ships. The digest, the hostnames and the chain stay strict; those are
   * the contract.
   */
  rootCaTeeQuote: z.unknown().optional(),
  tlsLeaf: z.string().min(1).optional(),
});

/** Mirror of `#/$defs/deploymentEvidencePayload` in the same schema. */
const PayloadSchema = z.looseObject({
  version: z.literal('1'),
  kind: z.literal('DeploymentEvidence'),
  hostname: z.string().min(1),
  issuedAt: z.iso.datetime({ offset: true }),
  certFingerprint: z.string().regex(FINGERPRINT),
  evidenceDigest: z.string().min(1),
  evidence: z.looseObject({}).optional(),
});

export type EvidenceBundle = z.infer<typeof BundleSchema>;

/** Everything an `EvidenceSnapshot` row is made of, with nothing derived from a signature. */
export interface ParsedEvidenceBundle {
  hostname: string;
  issuedAt: Date;
  digest: EvidenceDigest;
  certFingerprint: string;
  quoteFormat: string | null;
  containerImages: string[];
  workloads: EvidenceWorkloadSummary[];
  chainSummary: CertificateSummary[];
  measurements: Record<string, unknown> | null;
  jws: string;
  /**
   * The document exactly as the publisher served it, member order included.
   *
   * It is the validated *input* rather than the schema's output, and that is the
   * difference between relaying a document and rewriting it: `/v1/evidence` is
   * the only copy of this document a browser can read on a real deployment
   * (SUP-191), and a reader hashing what the router hands back against what the
   * platform's gateway serves has to get the same digest. Zod's output is a
   * fresh object carrying the declared members first and the pass-through ones
   * after — the same document, a different byte string. Nothing downstream reads
   * this member for anything but passing it on, so there is nothing to buy by
   * storing the reordered copy.
   */
  bundle: Record<string, unknown>;
}

export class EvidenceBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceBundleError';
  }
}

/**
 * @param raw   the JSON document served at the endpoint's evidence URL
 * @param hostname the endpoint hostname the bundle was fetched for; a bundle
 *   naming a different host is rejected rather than filed under this endpoint
 */
export function parseEvidenceBundle(raw: unknown, hostname: string): ParsedEvidenceBundle {
  const bundle = BundleSchema.safeParse(raw);
  if (!bundle.success) {
    throw new EvidenceBundleError(`bundle does not match the swarm-evidence v1 shape: ${issuesOf(bundle.error)}`);
  }
  if (bundle.data.hostname !== hostname) {
    throw new EvidenceBundleError(`bundle hostname "${bundle.data.hostname}" does not match endpoint "${hostname}"`);
  }
  // A router endpoint publishes DeploymentEvidence. The other two kinds describe
  // a cluster's control plane and carry no evidenceDigest to pin.
  if (bundle.data.kind !== 'DeploymentEvidence') {
    throw new EvidenceBundleError(`unsupported bundle kind "${bundle.data.kind}" (expected DeploymentEvidence)`);
  }

  const payload = decodePayload(bundle.data.jws);
  if (payload.hostname !== hostname) {
    throw new EvidenceBundleError(`JWS payload hostname "${payload.hostname}" does not match endpoint "${hostname}"`);
  }

  let digest: EvidenceDigest;
  try {
    digest = parseEvidenceDigest(payload.evidenceDigest);
  } catch (error) {
    throw new EvidenceBundleError(error instanceof EvidenceDigestError ? error.message : String(error));
  }

  return {
    hostname,
    // The signed `issuedAt` wins over the envelope's: it is the one the
    // gatekeeper reads, so the console must age the quote by the same clock.
    issuedAt: new Date(payload.issuedAt),
    digest,
    certFingerprint: payload.certFingerprint,
    quoteFormat: quoteFormatOf(bundle.data.rootCaTeeQuote),
    containerImages: containerImagesOf(payload.evidence),
    workloads: workloadsOf(payload.evidence),
    chainSummary: summariseChain(bundle.data.certChain),
    measurements: measurementsOf(payload, bundle.data),
    jws: bundle.data.jws,
    bundle: raw as Record<string, unknown>,
  };
}

/** Decodes the middle segment. No signature check — see the file comment. */
function decodePayload(jws: string): z.infer<typeof PayloadSchema> {
  const segment = jws.split('.')[1] as string;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch (error) {
    throw new EvidenceBundleError(`JWS payload is not JSON: ${(error as Error).message}`);
  }
  const payload = PayloadSchema.safeParse(parsed);
  if (!payload.success) {
    throw new EvidenceBundleError(`JWS payload is not a DeploymentEvidence payload: ${issuesOf(payload.error)}`);
  }
  return payload.data;
}

/**
 * The quote's `format` label, when the producer published a usable one.
 *
 * Anything else — an absent member, a placeholder, a `format` that is not a
 * non-empty string — reads as "not stated", which is what the evidence modal
 * already renders for a null.
 */
function quoteFormatOf(quote: unknown): string | null {
  const format = (quote as { format?: unknown } | undefined)?.format;
  return typeof format === 'string' && format.length > 0 ? format : null;
}

/**
 * Flattens the enclave image digests out of the canonical deployment snapshot
 * (`{ version: 2, resources: [...] }`) — what the Overview and the evidence
 * modal list under the digest.
 *
 * Two resource shapes are read, because the snapshot carries whatever the
 * producer deployed: a resource may hold `containers` directly, or it may be a
 * plain Kubernetes object that keeps them on a pod spec. The deployed platform
 * publishes the Kubernetes shape; reading only the flat one left the modal
 * empty for every real deployment (SUP-157).
 *
 * A shape neither of those recognises yields an empty list rather than an
 * error: the images are display detail and the digest is the contract.
 */
function containerImagesOf(evidence: unknown): string[] {
  const resources = (evidence as { resources?: unknown } | undefined)?.resources;
  if (!Array.isArray(resources)) {
    return [];
  }
  const images = new Set<string>();
  for (const resource of resources) {
    for (const spec of podSpecsOf(resource)) {
      // `initContainers` count: an init container runs on the same node with the
      // same access to the workload's secrets, so a user comparing what the
      // enclave runs has to see it.
      for (const key of ['containers', 'initContainers'] as const) {
        const containers = (spec as Record<string, unknown>)[key];
        if (!Array.isArray(containers)) continue;
        for (const container of containers) {
          // A null member would throw a bare TypeError out of a function whose
          // contract is that an unrecognised shape yields no images.
          if (!container || typeof container !== 'object') continue;
          const image = (container as { image?: unknown }).image;
          if (typeof image === 'string' && image.length > 0) {
            images.add(image);
          }
        }
      }
    }
  }
  return [...images];
}

/**
 * Every place a resource may keep a pod spec.
 *
 * The list covers the resource itself (the flat shape), a bare `Pod`, the
 * template every controller wraps one in — Deployment, ReplicaSet, StatefulSet,
 * DaemonSet, Job — and the extra level a CronJob adds. Enumerated rather than
 * searched recursively: a blind walk for anything called `containers` would
 * start reporting whatever a future resource happens to nest under that name.
 */
function podSpecsOf(resource: unknown): unknown[] {
  if (!resource || typeof resource !== 'object') {
    return [];
  }
  const spec = (resource as { spec?: unknown }).spec as
    | { template?: { spec?: unknown }; jobTemplate?: { spec?: { template?: { spec?: unknown } } } }
    | undefined;
  return [resource, spec, spec?.template?.spec, spec?.jobTemplate?.spec?.template?.spec].filter(
    (candidate): candidate is object => !!candidate && typeof candidate === 'object',
  );
}

/**
 * The Kubernetes workloads the canonical deployment snapshot declares, with the
 * containers each one runs.
 *
 * `containerImagesOf` above answers "what images does this deployment run"; this
 * answers "what runs them", which is the half a cloud-level admission cannot see
 * and the half SUP-221 ruling 1 makes the admin section render (threat T13).
 *
 * The recognised kinds are the ones that own a pod spec — enumerated rather than
 * inferred, for the same reason `podSpecsOf` enumerates: a blind walk would start
 * reporting whatever a future resource happens to nest under a familiar name. A
 * resource of any other kind, or one with no readable name, is skipped rather
 * than guessed at; an unrecognised snapshot yields an empty list, because this is
 * display detail and the digest is the contract.
 */
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob', 'Pod']);

export function workloadsOf(evidence: unknown): EvidenceWorkloadSummary[] {
  const resources = (evidence as { resources?: unknown } | undefined)?.resources;
  if (!Array.isArray(resources)) {
    return [];
  }
  const workloads: EvidenceWorkloadSummary[] = [];
  for (const resource of resources) {
    if (!resource || typeof resource !== 'object') continue;
    const kind = (resource as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !WORKLOAD_KINDS.has(kind)) continue;
    const metadata = (resource as { metadata?: unknown }).metadata as
      | { name?: unknown; namespace?: unknown }
      | undefined;
    const name = metadata?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    workloads.push({
      kind,
      name,
      namespace: typeof metadata?.namespace === 'string' && metadata.namespace.length > 0 ? metadata.namespace : null,
      containers: containerNamesOf(resource),
    });
  }
  return workloads;
}

/** Container names of one resource, init containers included and in declaration order. */
function containerNamesOf(resource: unknown): string[] {
  const names: string[] = [];
  for (const spec of podSpecsOf(resource)) {
    for (const key of ['initContainers', 'containers'] as const) {
      const containers = (spec as Record<string, unknown>)[key];
      if (!Array.isArray(containers)) continue;
      for (const container of containers) {
        if (!container || typeof container !== 'object') continue;
        const name = (container as { name?: unknown }).name;
        if (typeof name === 'string' && name.length > 0 && !names.includes(name)) {
          names.push(name);
        }
      }
    }
  }
  return names;
}

/**
 * Measurement registers (MRTD, RTMR0-2, GPU) when the producer publishes them.
 *
 * The bundle contract does not require them and does not fix where they sit, so
 * the known locations are tried in order of specificity and the first hit wins.
 * Absent is normal, not an error.
 */
function measurementsOf(
  payload: z.infer<typeof PayloadSchema>,
  bundle: EvidenceBundle,
): Record<string, unknown> | null {
  const candidates: unknown[] = [
    (payload.evidence as { measurements?: unknown } | undefined)?.measurements,
    (payload as { measurements?: unknown }).measurements,
    (bundle.rootCaTeeQuote as { collateral?: { measurements?: unknown } } | undefined)?.collateral?.measurements,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Subject, issuer, expiry and SHA-256 fingerprint of each PEM, leaf → root.
 *
 * Parsing the chain is not verifying it: nothing here checks that each
 * certificate signs the next, and the terminal fingerprint is reported so a
 * human can compare it with their own trust root — not so the router can.
 */
function summariseChain(pems: string[]): CertificateSummary[] {
  return pems.map((pem, index) => {
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(pem);
    } catch (error) {
      throw new EvidenceBundleError(`certChain[${index}] is not a PEM certificate: ${(error as Error).message}`);
    }
    return {
      subject: certificate.subject,
      issuer: certificate.issuer,
      notAfter: new Date(certificate.validTo).toISOString(),
      fingerprint: `sha256/${createHash('sha256').update(certificate.raw).digest('base64url')}`,
    };
  });
}

function issuesOf(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
}
