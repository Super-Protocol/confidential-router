import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import JSZip from 'jszip';
import { DataSource, In } from 'typeorm';
import { type SignedLinkClaims, signLink, verifyLink } from '../common/signed-link.js';
import { routerConfig } from '../config.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { Generation } from '../db/entities/generation.entity.js';

/** Audience of an evidence-export link. A token minted for anything else is refused. */
export const EVIDENCE_EXPORT_AUDIENCE = 'evidence:export';

/** How long an export link stays usable. Long enough to mail, short enough to expire. */
export const EVIDENCE_EXPORT_TTL_MS = 15 * 60 * 1000;

/** Cap on what one origin contributes to an export, so a year-wide range cannot be turned into an OOM. */
const MAX_SNAPSHOTS = 5_000;

export interface EvidenceExportClaims extends SignedLinkClaims {
  workspaceId: string;
  userId: string;
  from: number;
  to: number;
}

export interface EvidenceExportRequest {
  userId: string;
  workspaceId: string;
  from: Date;
  to: Date;
}

export interface EvidenceExportLink {
  url: string;
  expiresAt: Date;
}

/** Generations of one period grouped by the publication that covered them. */
interface SnapshotReference {
  /** The `evidence_snapshots` row, once one has been found for this group. */
  snapshot: EvidenceSnapshot | null;
  origin: 'own' | 'external';
  /** Name of the endpoint that served them, whichever table it lives in. */
  endpoint: string;
  evidenceDigest: string;
  generations: number;
}

/**
 * Packages the evidence a workspace's generations were served under, for an
 * auditor.
 *
 * The zip contains exactly what the platform published — bundle, JWS and the
 * digests — and a manifest saying which generation referenced which snapshot. It
 * contains no verdict: this router does not verify, and an export that implied
 * otherwise would be the design regression ADR-002 exists to prevent. Whoever
 * receives the zip verifies it with the gatekeeper.
 *
 * **Both origins are in it, and they are reached differently** (SUP-295 item 4).
 * A generation served by one of this deployment's own endpoints carries
 * `evidenceSnapshotId`, stamped as it was served. A generation served through an
 * external upstream carries none and never will: at the moment it is recorded
 * there is no row to point at — the upstream's bundle is fetched by a poller that
 * runs afterwards — so what it carries instead is `evidenceDigest`, the digest the
 * sidecar's verdict observed (ADR-008 §4, `generation-recorder.service.ts`). The
 * publication behind it is therefore resolved here, by `(externalEndpointId,
 * evidenceDigest)`, which is the same pairing `ExternalEvidenceService` files it
 * under. Until this was done, a deployment whose traffic is entirely external —
 * which is every deployment serving someone else's models — exported a manifest
 * with `"snapshots": []` however much it had served.
 */
@Injectable()
export class EvidenceExportService {
  private readonly logger = new Logger(EvidenceExportService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  /**
   * Mints an expiring, signed download link.
   *
   * A link rather than the bytes: the zip is built on demand and can be large,
   * and an auditor is usually not the person holding the console session — the
   * signature is what carries the authority off-session, bounded by `exp`.
   */
  link(request: EvidenceExportRequest, now = new Date()): EvidenceExportLink {
    if (request.to.getTime() <= request.from.getTime()) {
      throw new BadRequestException('The end of the range must be after its start.');
    }
    const token = signLink(
      this.config.auth.secret,
      {
        aud: EVIDENCE_EXPORT_AUDIENCE,
        workspaceId: request.workspaceId,
        userId: request.userId,
        from: request.from.getTime(),
        to: request.to.getTime(),
      },
      { ttlMs: EVIDENCE_EXPORT_TTL_MS, now: now.getTime() },
    );
    const url = new URL('/exports/evidence.zip', this.config.server.publicBaseUrl);
    url.searchParams.set('token', token);
    return { url: url.toString(), expiresAt: new Date(now.getTime() + EVIDENCE_EXPORT_TTL_MS) };
  }

  verifyToken(token: string): EvidenceExportClaims {
    return verifyLink<EvidenceExportClaims>(this.config.auth.secret, token, { audience: EVIDENCE_EXPORT_AUDIENCE });
  }

  async build(workspaceId: string, from: Date, to: Date): Promise<Buffer> {
    const [references, served] = await Promise.all([
      this.references(workspaceId, from, to),
      this.generationCount(workspaceId, from, to),
    ]);
    const found = references.filter(
      (reference): reference is SnapshotReference & { snapshot: EvidenceSnapshot } => reference.snapshot !== null,
    );

    const zip = new JSZip();
    const manifest = {
      workspaceId,
      from: from.toISOString(),
      to: to.toISOString(),
      generatedAt: new Date().toISOString(),
      // Said once, in the artefact itself, so the export cannot be mistaken for
      // an attestation result.
      note:
        'The Confidential Router publishes evidence and never verifies it. This archive is what the ' +
        'platform published for the endpoints that served these generations; verify it with the gatekeeper.',
      // What the period actually held, so a short archive can be read. An
      // archive with no snapshots and a four-figure `generations` is a fault to
      // report; one with no snapshots and no generations is a quiet month.
      generations: {
        served,
        covered: found.reduce((total, reference) => total + reference.generations, 0),
      },
      snapshots: found.map((reference) => ({
        id: reference.snapshot.id,
        endpoint: reference.endpoint,
        // Which table the endpoint lives in, and with it what the digest means:
        // `own` is what this deployment published about itself, `external` is
        // what an upstream published and this router's egress verifier saw
        // (ADR-008 §1). Neither is a verdict — see `note`.
        origin: reference.origin,
        evidenceDigest: reference.snapshot.evidenceDigest,
        evidenceDigestHex: reference.snapshot.evidenceDigestHex,
        certFingerprint: reference.snapshot.certFingerprint,
        issuedAt: reference.snapshot.issuedAt.toISOString(),
        fetchedAt: reference.snapshot.fetchedAt.toISOString(),
        quoteFormat: reference.snapshot.quoteFormat,
        containerImages: reference.snapshot.containerImages,
        generations: reference.generations,
        files: {
          bundle: `snapshots/${reference.snapshot.id}/bundle.json`,
          jws: `snapshots/${reference.snapshot.id}/evidence.jws`,
        },
      })),
      // Generations whose digest this router holds no bundle for: an upstream
      // that had already republished by the time the evidence poller asked, or
      // one it never reached. Named rather than dropped, because the digest is
      // what an auditor takes to the upstream to ask for the bundle itself.
      unretrieved: references
        .filter((reference) => reference.snapshot === null)
        .map((reference) => ({
          endpoint: reference.endpoint,
          origin: reference.origin,
          evidenceDigest: reference.evidenceDigest,
          generations: reference.generations,
        })),
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    for (const { snapshot } of found) {
      zip.file(`snapshots/${snapshot.id}/bundle.json`, JSON.stringify(snapshot.bundle, null, 2));
      zip.file(`snapshots/${snapshot.id}/evidence.jws`, snapshot.jws);
    }

    this.logger.log(
      `Exported ${found.length} evidence snapshots covering ${manifest.generations.covered} of ${served} ` +
        `generation(s) for workspace ${workspaceId}.`,
    );
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  /** Every publication the period's generations were served under, both origins. */
  private async references(workspaceId: string, from: Date, to: Date): Promise<SnapshotReference[]> {
    const [own, external] = await Promise.all([
      this.ownReferences(workspaceId, from, to),
      this.externalReferences(workspaceId, from, to),
    ]);
    return [...own, ...external];
  }

  /**
   * This deployment's own endpoints, reached through the stamp the metering path
   * wrote: `Generation.evidenceSnapshotId` is the snapshot that was current when
   * the request was served, and resolving it any other way would attribute a
   * later publication to an earlier generation.
   */
  private async ownReferences(workspaceId: string, from: Date, to: Date): Promise<SnapshotReference[]> {
    const rows = await this.period(workspaceId, from, to)
      .select('generation.evidenceSnapshotId', 'snapshotId')
      .addSelect('COUNT(*)', 'generations')
      .andWhere('generation.evidenceSnapshotId IS NOT NULL')
      .groupBy('generation.evidenceSnapshotId')
      .limit(MAX_SNAPSHOTS)
      .getRawMany<{ snapshotId: string; generations: string | number }>();
    if (rows.length === 0) {
      return [];
    }

    const snapshots = await this.dataSource
      .getRepository(EvidenceSnapshot)
      .find({ where: { id: In(rows.map((row) => row.snapshotId)) } });
    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const names = await this.ownEndpointNames(snapshots);

    return rows.flatMap((row) => {
      // A snapshot deleted by the retention sweep leaves the stamp behind
      // (`onDelete: 'SET NULL'` only fires on the relation this query bypasses),
      // and there is no digest on the row to name it by.
      const snapshot = byId.get(row.snapshotId);
      if (!snapshot) {
        return [];
      }
      return [
        {
          snapshot,
          origin: 'own' as const,
          endpoint: (snapshot.endpointId && names.get(snapshot.endpointId)) || snapshot.endpointId || 'unknown',
          evidenceDigest: snapshot.evidenceDigest,
          generations: Number(row.generations),
        },
      ];
    });
  }

  /**
   * External upstreams, reached through the digest a verdict observed.
   *
   * `(externalEndpointId, evidenceDigest)` is the pairing `ExternalEvidenceService`
   * files bundles under, so it is the pairing that reads them back. Rows are taken
   * in ascending `issuedAt` and the last write wins: a re-issue is the same facts
   * under a newer signature, and the fresher one is what an auditor should hold.
   */
  private async externalReferences(workspaceId: string, from: Date, to: Date): Promise<SnapshotReference[]> {
    const rows = await this.period(workspaceId, from, to)
      .select('generation.externalEndpointId', 'endpointId')
      .addSelect('generation.evidenceDigest', 'evidenceDigest')
      .addSelect('COUNT(*)', 'generations')
      .andWhere('generation.externalEndpointId IS NOT NULL')
      .andWhere('generation.evidenceDigest IS NOT NULL')
      .groupBy('generation.externalEndpointId')
      .addGroupBy('generation.evidenceDigest')
      .limit(MAX_SNAPSHOTS)
      .getRawMany<{ endpointId: string; evidenceDigest: string; generations: string | number }>();
    if (rows.length === 0) {
      return [];
    }

    const endpointIds = [...new Set(rows.map((row) => row.endpointId))];
    const [snapshots, endpoints] = await Promise.all([
      this.dataSource.getRepository(EvidenceSnapshot).find({
        where: {
          externalEndpointId: In(endpointIds),
          evidenceDigest: In([...new Set(rows.map((row) => row.evidenceDigest))]),
        },
        order: { issuedAt: 'ASC', fetchedAt: 'ASC' },
      }),
      // Two columns and no more: this table also holds the sealed upstream
      // credential, and an export is a file that leaves the building. Nothing
      // can be put in the zip that was never loaded.
      this.dataSource
        .getRepository(ExternalEndpoint)
        .find({ where: { id: In(endpointIds) }, select: { id: true, name: true } }),
    ]);
    // The two `In`s are a cross product, so the pairing is re-applied here —
    // one upstream's publication must never be filed under another's digest.
    const byPair = new Map(
      snapshots.map((snapshot) => [`${snapshot.externalEndpointId}\u0000${snapshot.evidenceDigest}`, snapshot]),
    );
    const names = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.name]));

    return rows.map((row) => ({
      snapshot: byPair.get(`${row.endpointId}\u0000${row.evidenceDigest}`) ?? null,
      origin: 'external' as const,
      endpoint: names.get(row.endpointId) ?? row.endpointId,
      evidenceDigest: row.evidenceDigest,
      generations: Number(row.generations),
    }));
  }

  /** How many generations the period held at all, covered or not. */
  private async generationCount(workspaceId: string, from: Date, to: Date): Promise<number> {
    const row = await this.period(workspaceId, from, to)
      .select('COUNT(*)', 'generations')
      .getRawOne<{ generations: string | number }>();
    return Number(row?.generations ?? 0);
  }

  private async ownEndpointNames(snapshots: EvidenceSnapshot[]): Promise<Map<string, string>> {
    const ids = [...new Set(snapshots.map((snapshot) => snapshot.endpointId).filter((id) => id !== null))];
    if (ids.length === 0) {
      return new Map();
    }
    const endpoints = await this.dataSource.getRepository(Endpoint).find({ where: { id: In(ids) } });
    return new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.name]));
  }

  /** The workspace's generations in the half-open period, as a query to narrow further. */
  private period(workspaceId: string, from: Date, to: Date) {
    return this.dataSource
      .getRepository(Generation)
      .createQueryBuilder('generation')
      .where('generation.workspaceId = :workspaceId', { workspaceId })
      .andWhere('generation.createdAt >= :from', { from: from.getTime() })
      .andWhere('generation.createdAt < :to', { to: to.getTime() });
  }
}
