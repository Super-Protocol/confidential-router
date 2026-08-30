import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig } from '../config.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';

/** What the platform had published for an endpoint when a request was served. */
export interface EvidenceCoverage {
  snapshotId: string;
  evidenceDigest: string;
}

/** How long a resolved snapshot is reused before the table is consulted again. */
const CACHE_TTL_MS = 10_000;

/**
 * Answers one question per request: was this endpoint publishing evidence when
 * we routed to it?
 *
 * That is all the router is allowed to record (ADR-002) — a fact about
 * publication, never a verdict about validity. Verification happens in the
 * user's gatekeeper, which is why nothing here inspects the bundle.
 *
 * Cached for a few seconds: the snapshot poller writes at minute scale, and a
 * table scan per generation would be pure overhead.
 */
@Injectable()
export class EvidenceCoverageService {
  private readonly cache = new Map<string, { at: number; coverage: EvidenceCoverage | null }>();

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async currentFor(endpointId: string, now: Date = new Date()): Promise<EvidenceCoverage | null> {
    const cached = this.cache.get(endpointId);
    if (cached && now.getTime() - cached.at < CACHE_TTL_MS) {
      return cached.coverage;
    }

    const snapshot = await this.dataSource.getRepository(EvidenceSnapshot).findOne({
      where: { endpointId },
      order: { issuedAt: 'DESC' },
      select: { id: true, evidenceDigest: true, issuedAt: true },
    });

    // A snapshot older than the freshness window is not coverage: the platform
    // published *something*, but not for the deployment serving this request.
    const fresh =
      snapshot && now.getTime() - snapshot.issuedAt.getTime() <= this.config.evidence.freshnessWindow ? snapshot : null;
    const coverage = fresh ? { snapshotId: fresh.id, evidenceDigest: fresh.evidenceDigest } : null;

    this.cache.set(endpointId, { at: now.getTime(), coverage });
    return coverage;
  }
}
