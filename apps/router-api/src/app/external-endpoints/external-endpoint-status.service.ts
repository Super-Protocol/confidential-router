import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not } from 'typeorm';
import { routerConfig } from '../config.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import {
  ExternalEndpointEvent,
  type ExternalEndpointEventKind,
} from '../db/entities/external-endpoint-event.entity.js';
import { ExternalCatalogService } from './external-catalog.service.js';
import { fetchSidecarVerdicts, type SidecarVerdict } from './sidecar-admin.client.js';
import { type ProjectedVerdict, projectVerdict } from './status-projection.js';

export interface SyncReport {
  /** Rows the sidecar reported on. */
  seen: number;
  /** Rows whose admission decision moved. */
  flipped: number;
  /** Timeline rows appended. */
  events: number;
}

/**
 * Projects the sidecar's live verdicts into `external_endpoints` and its event
 * timeline (ADR-008 §5 step 3, §8).
 *
 * The one rule this service exists to keep: **a stored status is never trust.**
 * It is a projection of a verdict the sidecar holds in memory right now, kept in
 * the database so the console can render it and so admission can read it without
 * an HTTP call per request. On boot {@link resetToPending} throws all of it away
 * — because the sidecar has thrown its own away too, and a row that said
 * `verified` across a restart would be the persisted verdict ADR-008 refuses.
 */
@Injectable()
export class ExternalEndpointStatusService {
  private readonly logger = new Logger(ExternalEndpointStatusService.name);

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly catalog: ExternalCatalogService,
  ) {}

  /**
   * Returns every enabled endpoint to `pending`, clearing the verdict columns.
   *
   * Called once at boot, before the first poll. `disabled` rows are left alone:
   * that value is the operator's switch, not a verdict, and the status poll is
   * not entitled to it.
   *
   * No event is written. Nothing happened to the endpoint — this process
   * restarted, which is this process's news and not the upstream's.
   */
  async resetToPending(): Promise<number> {
    const repository = this.dataSource.getRepository(ExternalEndpoint);
    // A `pending` row can carry a verdict too since SUP-252 — a deployment awaiting
    // approval was checked, and its factors are on the row — so the reset is about
    // what the row holds, not only its status. Matched on the varchar verdict
    // columns: `lastCheckedAt` goes through a column transformer that an `IS NOT
    // NULL` operator cannot pass through.
    const stale = await repository.find({
      select: { id: true },
      where: [
        { enabled: true, status: Not('pending') },
        { enabled: true, lastStage: Not(IsNull()) },
        { enabled: true, evidenceDigestSeen: Not(IsNull()) },
        { enabled: true, observedCertFingerprint: Not(IsNull()) },
      ],
    });
    if (stale.length === 0) {
      await this.catalog.refresh();
      return 0;
    }
    const { affected } = await repository.update(
      { id: In(stale.map((row) => row.id)) },
      {
        status: 'pending',
        lastStage: null,
        lastReason: null,
        measurementSeen: null,
        measurementSource: null,
        measurementInRegistry: null,
        evidenceDigestSeen: null,
        pinnedCertFingerprint: null,
        observedCertFingerprint: null,
        lastCheckedAt: null,
        updatedAt: new Date(),
      },
    );
    const reset = affected ?? 0;
    if (reset > 0) {
      this.logger.log(
        `${reset} external endpoint(s) held at pending until the sidecar reports a live verdict (ADR-008 §8).`,
      );
    }
    await this.catalog.refresh();
    return reset;
  }

  /**
   * One pass: read `/verdicts`, project each one, rebuild the catalogue if any
   * admission decision moved.
   *
   * An endpoint the sidecar does not mention is left as it is rather than reset.
   * The usual cause is a render that has not reached the sidecar yet, and
   * `pending` is already where a new row starts — overwriting a live verdict
   * because one poll raced a reload would flap the catalogue for no reason.
   */
  async sync(now: Date = new Date()): Promise<SyncReport> {
    const verdicts = await fetchSidecarVerdicts(this.config.externalEndpoints.adminListen);
    const byName = new Map(verdicts.map((verdict) => [verdict.endpoint, verdict]));
    const endpoints = await this.dataSource.getRepository(ExternalEndpoint).find({ where: { enabled: true } });

    const report: SyncReport = { seen: 0, flipped: 0, events: 0 };
    for (const endpoint of endpoints) {
      const verdict = byName.get(endpoint.name);
      if (!verdict) {
        continue;
      }
      report.seen += 1;
      const projected = projectVerdict(endpoint, verdict, now);
      if (projected.patchChanged || projected.events.length > 0) {
        await this.apply(endpoint.id, projected, now);
      }
      report.events += projected.events.length;
      if (projected.statusChanged) {
        report.flipped += 1;
        this.logger.log(
          `External endpoint "${endpoint.name}" is now ${projected.patch.status}${reasonSuffix(verdict)}.`,
        );
      }
    }

    if (report.flipped > 0) {
      // Membership of `/v1/models` follows the verdict, so the map is rebuilt in
      // the same pass that saw the flip rather than on the next request.
      await this.catalog.refresh();
    }
    return report;
  }

  /**
   * Appends one event the sidecar has no opinion about — registration, a disable, a
   * key rotation, an approved digest. `evidenceDigest` is what a `digest_pinned`
   * event approved.
   */
  async recordEvent(
    externalEndpointId: string,
    kind: ExternalEndpointEventKind,
    { now = new Date(), evidenceDigest = null }: { now?: Date; evidenceDigest?: string | null } = {},
  ): Promise<void> {
    await this.dataSource.getRepository(ExternalEndpointEvent).save({
      id: randomUUID(),
      externalEndpointId,
      at: now,
      kind,
      stage: null,
      reason: null,
      measurement: null,
      evidenceDigest,
    });
  }

  private async apply(externalEndpointId: string, projected: ProjectedVerdict, now: Date): Promise<void> {
    // One transaction: a timeline that recorded a flip the row did not take, or
    // a row that flipped with no event behind it, would each be a history an
    // operator cannot act on.
    await this.dataSource.transaction(async (manager) => {
      await manager.update(ExternalEndpoint, { id: externalEndpointId }, { ...projected.patch, updatedAt: now });
      for (const event of projected.events) {
        await manager.save(ExternalEndpointEvent, { id: randomUUID(), externalEndpointId, at: now, ...event });
      }
    });
  }
}

function reasonSuffix(verdict: SidecarVerdict): string {
  const reason = verdict.reason ?? verdict.report?.reason;
  return reason ? ` (${reason})` : '';
}
