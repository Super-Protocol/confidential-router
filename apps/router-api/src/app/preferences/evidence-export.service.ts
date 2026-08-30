import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import JSZip from 'jszip';
import { DataSource, In } from 'typeorm';
import { type SignedLinkClaims, signLink, verifyLink } from '../common/signed-link.js';
import { routerConfig } from '../config.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { Generation } from '../db/entities/generation.entity.js';

/** Audience of an evidence-export link. A token minted for anything else is refused. */
export const EVIDENCE_EXPORT_AUDIENCE = 'evidence:export';

/** How long an export link stays usable. Long enough to mail, short enough to expire. */
export const EVIDENCE_EXPORT_TTL_MS = 15 * 60 * 1000;

/** Cap on one export, so a year-wide range cannot be turned into an OOM. */
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

/**
 * Packages the evidence a workspace's generations were served under, for an
 * auditor.
 *
 * The zip contains exactly what the platform published — bundle, JWS and the
 * digests — and a manifest saying which generation referenced which snapshot. It
 * contains no verdict: this router does not verify, and an export that implied
 * otherwise would be the design regression ADR-002 exists to prevent. Whoever
 * receives the zip verifies it with the gatekeeper.
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
    const references = await this.dataSource
      .getRepository(Generation)
      .createQueryBuilder('generation')
      .select('generation.evidenceSnapshotId', 'snapshotId')
      .addSelect('COUNT(*)', 'generations')
      .where('generation.workspaceId = :workspaceId', { workspaceId })
      .andWhere('generation.createdAt >= :from', { from: from.getTime() })
      .andWhere('generation.createdAt < :to', { to: to.getTime() })
      .andWhere('generation.evidenceSnapshotId IS NOT NULL')
      .groupBy('generation.evidenceSnapshotId')
      .limit(MAX_SNAPSHOTS)
      .getRawMany<{ snapshotId: string; generations: string | number }>();

    const snapshots = references.length
      ? await this.dataSource
          .getRepository(EvidenceSnapshot)
          .find({ where: { id: In(references.map((reference) => reference.snapshotId)) } })
      : [];
    const endpoints = snapshots.length
      ? await this.dataSource
          .getRepository(Endpoint)
          .find({ where: { id: In([...new Set(snapshots.map((snapshot) => snapshot.endpointId))]) } })
      : [];
    const endpointNames = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.name]));
    const counts = new Map(references.map((reference) => [reference.snapshotId, Number(reference.generations)]));

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
      snapshots: snapshots.map((snapshot) => ({
        id: snapshot.id,
        endpoint: endpointNames.get(snapshot.endpointId) ?? snapshot.endpointId,
        evidenceDigest: snapshot.evidenceDigest,
        evidenceDigestHex: snapshot.evidenceDigestHex,
        certFingerprint: snapshot.certFingerprint,
        issuedAt: snapshot.issuedAt.toISOString(),
        fetchedAt: snapshot.fetchedAt.toISOString(),
        quoteFormat: snapshot.quoteFormat,
        containerImages: snapshot.containerImages,
        generations: counts.get(snapshot.id) ?? 0,
        files: {
          bundle: `snapshots/${snapshot.id}/bundle.json`,
          jws: `snapshots/${snapshot.id}/evidence.jws`,
        },
      })),
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    for (const snapshot of snapshots) {
      zip.file(`snapshots/${snapshot.id}/bundle.json`, JSON.stringify(snapshot.bundle, null, 2));
      zip.file(`snapshots/${snapshot.id}/evidence.jws`, snapshot.jws);
    }

    this.logger.log(`Exported ${snapshots.length} evidence snapshots for workspace ${workspaceId}.`);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
}
