import { createHash, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import type { CertificateSummary } from '../db/entities/evidence-snapshot.entity.js';
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
  rootCaTeeQuote: z
    .looseObject({
      format: z.string().min(1),
      data: z.string().min(1),
      collateral: z.looseObject({}).optional(),
    })
    .optional(),
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
  chainSummary: CertificateSummary[];
  measurements: Record<string, unknown> | null;
  jws: string;
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
    quoteFormat: bundle.data.rootCaTeeQuote?.format ?? null,
    containerImages: containerImagesOf(payload.evidence),
    chainSummary: summariseChain(bundle.data.certChain),
    measurements: measurementsOf(payload, bundle.data),
    jws: bundle.data.jws,
    bundle: bundle.data as Record<string, unknown>,
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
 * Flattens the container images out of the canonical deployment snapshot
 * (`{ version: 2, resources: [{ containers: [{ image }] }] }`). These are the
 * enclave image digests the Overview and the evidence modal show; a snapshot in
 * a shape this does not recognise yields an empty list rather than an error,
 * because the images are display detail and the digest is the contract.
 */
function containerImagesOf(evidence: unknown): string[] {
  const resources = (evidence as { resources?: unknown } | undefined)?.resources;
  if (!Array.isArray(resources)) {
    return [];
  }
  const images = new Set<string>();
  for (const resource of resources) {
    const containers = (resource as { containers?: unknown }).containers;
    if (!Array.isArray(containers)) continue;
    for (const container of containers) {
      const image = (container as { image?: unknown }).image;
      if (typeof image === 'string' && image.length > 0) {
        images.add(image);
      }
    }
  }
  return [...images];
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
    (bundle.rootCaTeeQuote?.collateral as { measurements?: unknown } | undefined)?.measurements,
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
