import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, In } from 'typeorm';
import { routerConfig } from '../config.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import {
  ExternalEndpointEvent,
  type ExternalEndpointEventKind,
} from '../db/entities/external-endpoint-event.entity.js';
import { ExternalCatalogService } from './external-catalog.service.js';
import { ExternalEndpointHealth } from './external-endpoint-health.js';
import {
  durationSince,
  type EndpointLiveness,
  livenessOf,
  type OutageThresholds,
  outageLine,
  outageReason,
  recoveryLine,
} from './external-endpoint-liveness.js';
import { fetchSidecarVerdicts, type SidecarVerdict } from './sidecar-admin.client.js';
import { clip, type ProjectedVerdict, projectVerdict } from './status-projection.js';

export interface SyncReport {
  /** Rows the sidecar reported on. */
  seen: number;
  /** Rows whose admission decision moved. */
  flipped: number;
  /** Timeline rows appended. */
  events: number;
  /** Runs that crossed an outage threshold in this pass and were alerted on. */
  outages: number;
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
 *
 * Since SUP-517 it also projects the *run* each verdict belongs to and alerts
 * when one crosses a threshold. That lives here rather than in a service of its
 * own because the pass already holds the rows, the thresholds and the clock: a
 * second reader would be a second opinion about whether an upstream is serving,
 * arrived at from the same table a moment later. The rules themselves are pure
 * and shared — `external-endpoint-liveness.ts`.
 */
@Injectable()
export class ExternalEndpointStatusService {
  private readonly logger = new Logger(ExternalEndpointStatusService.name);

  /**
   * Which outage runs this process has already alerted on, by endpoint id, keyed
   * on the run's `notServingSince`.
   *
   * In memory, not a column, and the key is what makes that safe: a *new* run has
   * a different start, so it alerts again, while the same run alerted on every
   * five-second poll would be a line a log alert is tuned to ignore. A restart
   * clears it and the run — `notServingSince` is reset on boot too — so a process
   * that comes up and still cannot reach an upstream says so again. That is the
   * right behaviour, not a duplicate: it is news that the new process cannot
   * reach it either.
   */
  private readonly alerted = new Map<string, number>();

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly catalog: ExternalCatalogService,
    private readonly health: ExternalEndpointHealth,
  ) {}

  /**
   * Returns every enabled endpoint to `pending`, clearing the verdict columns
   * and starting its "not serving" clock at `now`.
   *
   * Called once at boot, before the first poll. `disabled` rows are left alone:
   * that value is the operator's switch, not a verdict, and the status poll is
   * not entitled to it.
   *
   * No event is written. Nothing happened to the endpoint — this process
   * restarted, which is this process's news and not the upstream's.
   *
   * Every enabled row is written, not only the ones holding a stale verdict,
   * because `notServingSince` moves on all of them: as of this boot no endpoint
   * is known to serve, and that is the instant the outage thresholds are measured
   * from (SUP-517). It also publishes the first `/health` answer, so the route
   * reports `unknown` with a true count from the moment the process is up rather
   * than `none` until the first poll lands.
   */
  async resetToPending(now: Date = new Date()): Promise<number> {
    const repository = this.dataSource.getRepository(ExternalEndpoint);
    const enabled = await repository.find({ where: { enabled: true } });
    const reset = {
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
      lastSuccessAt: null,
      lastFailureAt: null,
      notServingSince: now,
      consecutiveFailures: 0,
    } as const satisfies Partial<ExternalEndpoint>;

    if (enabled.length > 0) {
      await repository.update({ id: In(enabled.map((row) => row.id)) }, { ...reset, updatedAt: now });
      this.logger.log(
        `${enabled.length} external endpoint(s) held at pending until the sidecar reports a live verdict (ADR-008 §8).`,
      );
    }
    await this.catalog.refresh();
    // No verdict has been read back, so the summary is honest about that rather
    // than about the rows it just wrote.
    this.publish(
      enabled.map((row) => ({ ...row, ...reset })),
      null,
      now,
    );
    this.alerted.clear();
    return enabled.length;
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

    const report: SyncReport = { seen: 0, flipped: 0, events: 0, outages: 0 };
    // The rows as this pass leaves them. Collected rather than re-read: the
    // alerting and the `/health` summary are statements about the verdict just
    // projected, and a second `find` could only disagree with it.
    const projectedRows: ExternalEndpoint[] = [];
    for (const endpoint of endpoints) {
      const verdict = byName.get(endpoint.name);
      if (!verdict) {
        projectedRows.push(endpoint);
        continue;
      }
      report.seen += 1;
      const projected = projectVerdict(endpoint, verdict, now);
      if (projected.patchChanged || projected.events.length > 0) {
        await this.apply(endpoint.id, projected, now);
      }
      projectedRows.push({ ...endpoint, ...projected.patch });
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
    report.outages = await this.alertOnOutages(projectedRows, now);
    report.events += report.outages;
    this.publish(projectedRows, now, now);
    return report;
  }

  /**
   * Publishes what `/health` reports, from rows alone — for a pass whose sidecar
   * read failed.
   *
   * The counts are then the last projection plus whatever an admin has changed
   * since, and `verdictsReadAt` stops moving, which is exactly the shape of "this
   * router is no longer being told anything". Without it a sidecar that stopped
   * answering would leave `/health` frozen on the last successful pass with
   * nothing to say it was frozen.
   */
  async refreshHealth(now: Date = new Date()): Promise<void> {
    const endpoints = await this.dataSource.getRepository(ExternalEndpoint).find({ where: { enabled: true } });
    this.publish(endpoints, null, now);
  }

  /**
   * Appends one event the sidecar has no opinion about — registration, a disable, a
   * key rotation, an approved digest, a withdrawn one. `evidenceDigest` is what a
   * `digest_pinned` event approved, or what a `digest_unpinned` one stopped
   * approving; `reason` is the operator's explanation where the kind alone does
   * not carry it, clipped to the column the way a projected verdict's is.
   *
   * `manager` writes it on the caller's transaction, which is what a mutation
   * whose row change and whose timeline entry are the same fact passes — for the
   * reason {@link apply} states: a row that changed with no event behind it is a
   * history an operator cannot act on.
   */
  async recordEvent(
    externalEndpointId: string,
    kind: ExternalEndpointEventKind,
    {
      now = new Date(),
      evidenceDigest = null,
      reason = null,
      stage = null,
      manager,
    }: {
      now?: Date;
      evidenceDigest?: string | null;
      reason?: string | null;
      stage?: string | null;
      manager?: EntityManager;
    } = {},
  ): Promise<void> {
    await (manager ?? this.dataSource.manager).getRepository(ExternalEndpointEvent).save({
      id: randomUUID(),
      externalEndpointId,
      at: now,
      kind,
      stage: clip(stage, 32),
      reason: clip(reason, 255),
      measurement: null,
      evidenceDigest,
    });
  }

  /**
   * Turns a *run* of failed checks into something that wakes somebody (SUP-517).
   *
   * This is the half the router was missing. A denied verdict was already
   * logged, already dropped the model from `/v1/models` and already answered 503
   * — correctly, and in silence. A production upstream lost the gateway route for
   * its hostname and answered 503 for 30 hours before a human noticed; the
   * difference between that and a page is this method.
   *
   * `logger.error` is the alert, and it is deliberately the only one: this
   * deployment has no pager to call, and inventing an outbound channel here would
   * be a second thing to keep working. `error` is a severity a log sink can match
   * on, the line carries everything needed to act without opening a console
   * (`outageLine`), and `GET /health` and the endpoint's own timeline carry the
   * same verdict for whoever arrives later.
   *
   * Exactly once per run, in each direction. See {@link alerted}.
   */
  private async alertOnOutages(rows: readonly ExternalEndpoint[], now: Date): Promise<number> {
    const thresholds = this.thresholds();
    let alerts = 0;
    for (const row of rows) {
      const liveness = livenessOf(row, thresholds, now);
      const run = row.notServingSince?.getTime() ?? null;
      const alerted = this.alerted.get(row.id);

      if (liveness.outage && run !== null && alerted !== run) {
        this.alerted.set(row.id, run);
        alerts += 1;
        this.logger.error(outageLine(liveness, now));
        await this.recordEvent(row.id, 'outage', {
          now,
          stage: liveness.stage,
          reason: outageReason(liveness, now),
          evidenceDigest: row.evidenceDigestSeen,
        });
        continue;
      }
      // Recovery is keyed on the run being *over* — `notServingSince` cleared by
      // an admitting verdict — rather than on `outage` having gone false, which
      // it also does when an operator disables the endpoint or withdraws its
      // approval. Those end the alert; they do not mean the upstream came back.
      if (alerted !== undefined && row.notServingSince === null) {
        this.alerted.delete(row.id);
        alerts += 1;
        this.logger.log(recoveryLine(liveness, new Date(alerted), now));
        await this.recordEvent(row.id, 'recovered', {
          now,
          reason: `Serving again after ${durationSince(new Date(alerted), now)}.`,
          evidenceDigest: row.evidenceDigestSeen,
        });
      }
    }
    // A row that left the enabled set takes its latch with it: re-enabling it
    // starts a new run, which is entitled to its own alert.
    const present = new Set(rows.map((row) => row.id));
    for (const id of [...this.alerted.keys()]) {
      if (!present.has(id)) {
        this.alerted.delete(id);
      }
    }
    return alerts;
  }

  /** The same view three readers share: the alert above, the timeline, and `/health`. */
  private publish(rows: readonly ExternalEndpoint[], verdictsReadAt: Date | null, now: Date): void {
    const thresholds = this.thresholds();
    const livenesses: EndpointLiveness[] = rows.map((row) => livenessOf(row, thresholds, now));
    this.health.report(livenesses, verdictsReadAt);
  }

  private thresholds(): OutageThresholds {
    return this.config.externalEndpoints.outage;
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
