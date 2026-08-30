import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Generation } from '../db/entities/generation.entity.js';

export interface CoverageWindow {
  workspaceId: string;
  from: Date;
  to: Date;
  endpointId?: string;
}

export interface Coverage {
  requests: number;
  /** Of `requests`, those served while the endpoint had a fresh snapshot. */
  covered: number;
  /** `covered / requests`, or 0 when nothing was served. */
  ratio: number;
}

/**
 * Evidence coverage: of the generations served in a window, how many were served
 * while the platform had a fresh bundle published for the endpoint that served
 * them.
 *
 * This is a router-known fact — "did the platform publish a quote for this
 * endpoint when I served this" — and deliberately not a verification rate
 * (ADR-002). The per-request half of it lives in the metering path, which stamps
 * `Generation.evidenceSnapshotId` at the moment of the request; this service only
 * counts those stamps afterwards.
 */
@Injectable()
export class EvidenceCoverageStatsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async summary(window: CoverageWindow): Promise<Coverage> {
    const query = this.dataSource
      .getRepository(Generation)
      .createQueryBuilder('generation')
      .select('COUNT(generation.id)', 'requests')
      .addSelect('COUNT(generation.evidenceSnapshotId)', 'covered')
      .where('generation.workspaceId = :workspaceId', { workspaceId: window.workspaceId })
      .andWhere('generation.createdAt >= :from', { from: window.from.getTime() })
      .andWhere('generation.createdAt < :to', { to: window.to.getTime() });
    if (window.endpointId) {
      query.andWhere('generation.endpointId = :endpointId', { endpointId: window.endpointId });
    }
    const row = await query.getRawOne<{ requests: string | number; covered: string | number }>();
    return coverageOf(Number(row?.covered ?? 0), Number(row?.requests ?? 0));
  }

  /** Tokens routed through an endpoint in a window, for the endpoint table. */
  async tokensByEndpoint(window: CoverageWindow): Promise<Map<string, number>> {
    const rows = await this.dataSource
      .getRepository(Generation)
      .createQueryBuilder('generation')
      .select('generation.endpointId', 'endpointId')
      .addSelect('COALESCE(SUM(generation.promptTokens + generation.completionTokens), 0)', 'tokens')
      .where('generation.workspaceId = :workspaceId', { workspaceId: window.workspaceId })
      .andWhere('generation.createdAt >= :from', { from: window.from.getTime() })
      .andWhere('generation.createdAt < :to', { to: window.to.getTime() })
      .groupBy('generation.endpointId')
      .getRawMany<{ endpointId: string; tokens: string | number }>();

    return new Map(rows.map((row) => [row.endpointId, Number(row.tokens)]));
  }
}

/**
 * The ratio, with the one case that matters spelled out: a workspace that served
 * nothing has 0 coverage, not 100%. Reporting "all covered" for an empty window
 * would put a reassuring number on a screen backed by no evidence at all.
 */
export function coverageOf(covered: number, requests: number): Coverage {
  return { requests, covered, ratio: requests > 0 ? covered / requests : 0 };
}
