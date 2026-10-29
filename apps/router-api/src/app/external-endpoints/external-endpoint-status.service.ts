import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, In } from 'typeorm';
import { OperatorAlertsService } from '../alerts/operator-alerts.service.js';
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
  outageAlert,
  outageLine,
  outageReason,
  recoveryAlert,
  recoveryLine,
} from './external-endpoint-liveness.js';
import { fetchSidecarVerdicts, type SidecarVerdict } from './sidecar-admin.client.js';
import {
  clip,
  expireVerdict,
  type ProjectedVerdict,
  projectVerdict,
  verdictAttestWindowMs,
  verdictGraceMs,
} from './status-projection.js';

/** What one alerting pass said out loud, by direction. */
interface OutageAlerts {
  declared: number;
  recovered: number;
}

export interface SyncReport {
  /** Rows the sidecar reported on. */
  seen: number;
  /** Rows whose admission decision moved. */
  flipped: number;
  /** Timeline rows appended. */
  events: number;
  /** Runs that crossed an outage threshold in this pass. Declarations only — a recovery is not one. */
  outages: number;
  /** Verdicts this pass let go of because the sidecar stopped confirming them (SUP-583). */
  expired: number;
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

  /**
   * When this process last read a verdict naming each endpoint, by endpoint id —
   * the clock {@link expireVerdict} measures against (SUP-583).
   *
   * In memory, and a process lifetime is the right scope rather than a
   * compromise: the question is "is this router still being told that this
   * upstream is admitted", which is only ever about this process. A restart
   * answers it from scratch, and {@link resetToPending} has already thrown away
   * every verdict by then, so there is nothing for an empty map to be wrong
   * about.
   *
   * Not a column, and not `lastCheckedAt`: that one carries the *sidecar's*
   * timestamp, which is up to a whole `reattestInterval` — ten minutes — old on a
   * healthy endpoint. Expiring on it would retire every verdict in the product.
   */
  private readonly confirmedAt = new Map<string, number>();

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly catalog: ExternalCatalogService,
    private readonly health: ExternalEndpointHealth,
    private readonly alerts: OperatorAlertsService,
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
      upstreamUnreachable: null,
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
    this.confirmedAt.clear();
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
   * "Left as it is" has a limit, and {@link expireStaleVerdicts} is it: an
   * endpoint that goes unmentioned for a minute has no live verdict, whatever
   * the row still says.
   */
  async sync(now: Date = new Date()): Promise<SyncReport> {
    const verdicts = await fetchSidecarVerdicts(this.config.externalEndpoints.adminListen);
    const byName = new Map(verdicts.map((verdict) => [verdict.endpoint, verdict]));
    const endpoints = await this.dataSource.getRepository(ExternalEndpoint).find({ where: { enabled: true } });

    const report: SyncReport = { seen: 0, flipped: 0, events: 0, outages: 0, expired: 0 };
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
      // The sidecar named this endpoint, so its verdict is current as of this
      // read — whatever `checkedAt` says about when the sidecar last attested.
      this.confirmedAt.set(endpoint.id, now.getTime());
      const projected = projectVerdict(endpoint, verdict, {
        now,
        attestWindowMs: verdictAttestWindowMs(this.config.externalEndpoints.reattestInterval),
      });
      if (projected.patchChanged || projected.events.length > 0) {
        await this.apply(endpoint.id, projected, now);
      }
      projectedRows.push({ ...endpoint, ...projected.patch });
      report.events += projected.events.length;
      if (projected.statusChanged) {
        report.flipped += 1;
        const withdrawn = projected.events.some((event) => event.kind === 'verdict_expired');
        if (withdrawn) {
          // A warning rather than the usual flip line, and counted as an expiry:
          // this is not the sidecar reporting a change, it is this router
          // refusing to keep repeating one (ADR-008 §8).
          report.expired += 1;
          this.logger.warn(
            `External endpoint "${endpoint.name}" has lost its verdict: ${projected.patch.lastReason} ` +
              'Its models are no longer routable (ADR-008 §8).',
          );
        } else {
          this.logger.log(
            `External endpoint "${endpoint.name}" is now ${projected.patch.status}${reasonSuffix(verdict)}.`,
          );
        }
      }
    }

    // Before the alerting and the publish, so that all three readers see the same
    // rows: an expired verdict is a row that stopped serving, and the pass that
    // let go of it is the pass that should say so.
    const expired = await this.expireStaleVerdicts(projectedRows, now);
    report.expired += expired.rows.length;
    report.events += expired.rows.length;

    if (report.flipped > 0 || report.expired > 0) {
      // Membership of `/v1/models` follows the verdict, so the map is rebuilt in
      // the same pass that saw the flip rather than on the next request.
      await this.catalog.refresh();
    }
    const alerts = await this.alertOnOutages(expired.projected, now);
    report.outages = alerts.declared;
    report.events += alerts.declared + alerts.recovered;
    this.publish(expired.projected, now, now);
    return report;
  }

  /**
   * The same pass from the rows alone, for when the sidecar could not be read.
   *
   * It both publishes and **alerts**, and the alerting is the point. One pod, one
   * sidecar, both in the same container group: a sidecar that wedges or dies
   * takes every external model down with it, and nothing arrives to project — so
   * the path that reaches `alertOnOutages` through a successful `/verdicts` read
   * never runs. Before this, `/health` would flip to `outage` after
   * `outage.afterNoSuccess` while the log said nothing but one deduped warning,
   * which is both the failure most likely to look like silence and the exact
   * disagreement between readers `external-endpoint-liveness.ts` refuses.
   *
   * `verdictsReadAt` stops moving, which is the honest shape of "this router is
   * no longer being told anything": the counts are the last projection plus
   * whatever an admin has changed since, and the timestamp beside them says when
   * they stopped being news.
   */
  async refreshFromRows(now: Date = new Date()): Promise<void> {
    const endpoints = await this.dataSource.getRepository(ExternalEndpoint).find({ where: { enabled: true } });
    // This is the path a wedged sidecar leaves the router on, so it is the path
    // that has to let go of the verdicts it can no longer re-read (SUP-583).
    const expired = await this.expireStaleVerdicts(endpoints, now);
    if (expired.rows.length > 0) {
      await this.catalog.refresh();
    }
    await this.alertOnOutages(expired.projected, now);
    this.publish(expired.projected, null, now);
  }

  /**
   * Lets go of every verdict the sidecar has stopped confirming, and says so on
   * the timeline (SUP-583).
   *
   * The rule itself is {@link expireVerdict}; this is the write. Called from both
   * passes, because both can leave a `verified` row unconfirmed: the sidecar may
   * answer and not mention an endpoint, or it may not answer at all. One rule for
   * the two, so the catalogue cannot keep a model alive through whichever shape
   * of silence it happened to meet.
   *
   * @returns the rows as this pass leaves them (`projected`) and the ones it
   *   expired (`rows`), so the caller can rebuild the catalogue, alert and publish
   *   from the same values rather than re-reading them.
   */
  private async expireStaleVerdicts(
    rows: readonly ExternalEndpoint[],
    now: Date,
  ): Promise<{ projected: ExternalEndpoint[]; rows: ExternalEndpoint[] }> {
    const grace = verdictGraceMs(this.config.externalEndpoints.statusPollInterval);
    const projected: ExternalEndpoint[] = [];
    const expired: ExternalEndpoint[] = [];
    for (const row of rows) {
      const confirmed = this.confirmedAt.get(row.id) ?? null;
      const lapsed = expireVerdict(row, {
        confirmedAt: confirmed === null ? null : new Date(confirmed),
        graceMs: grace,
        now,
      });
      if (!lapsed) {
        projected.push(row);
        continue;
      }
      await this.apply(row.id, lapsed, now);
      this.confirmedAt.delete(row.id);
      const after = { ...row, ...lapsed.patch };
      projected.push(after);
      expired.push(after);
      this.logger.warn(
        `External endpoint "${row.name}" has lost its verdict: ${lapsed.patch.lastReason} ` +
          'Its models are no longer routable (ADR-008 §8).',
      );
    }
    // A row that left the enabled set takes its clock with it, for the reason the
    // alert latch is pruned the same way.
    const present = new Set(rows.map((row) => row.id));
    for (const id of [...this.confirmedAt.keys()]) {
      if (!present.has(id)) {
        this.confirmedAt.delete(id);
      }
    }
    return { projected, rows: expired };
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
   * Four readers, and the fourth is the one that matters (SUP-535). `logger.error`
   * is a severity a log sink can match on; the timeline and `GET /health` carry
   * the same verdict for whoever arrives later. None of those three reaches
   * anybody who is not already looking — this deployment has no log alarm, and
   * both production outages so far were found by a person stumbling over them. So
   * the fourth reader is `OperatorAlertsService`, which puts the same facts in an
   * operator's inbox by the one outbound channel this deployment proves every
   * day: the mail provider the sign-in codes go out through.
   *
   * The send is awaited, and it cannot fail this pass: `raise` never rejects, and
   * the row, the line and the `/health` status are all written first, so an alert
   * that could not be delivered costs a detected outage no visibility it had
   * before.
   *
   * Exactly once per run, in each direction. See {@link alerted}.
   *
   * Called from both passes — the one that read `/verdicts` and
   * {@link refreshFromRows}, which is all there is when the sidecar itself cannot
   * be read. The {@link alerted} latch is what makes that safe: whichever pass
   * gets there first declares the run, and the other one finds it already
   * declared.
   */
  private async alertOnOutages(rows: readonly ExternalEndpoint[], now: Date): Promise<OutageAlerts> {
    const thresholds = this.thresholds();
    const alerts: OutageAlerts = { declared: 0, recovered: 0 };
    for (const row of rows) {
      const liveness = livenessOf(row, thresholds, now);
      const run = row.notServingSince?.getTime() ?? null;
      const alerted = this.alerted.get(row.id);

      if (liveness.outage && run !== null && alerted !== run) {
        this.alerted.set(row.id, run);
        alerts.declared += 1;
        this.logger.error(outageLine(liveness, now));
        await this.recordEvent(row.id, 'outage', {
          now,
          stage: liveness.stage,
          reason: outageReason(liveness, now),
          evidenceDigest: row.evidenceDigestSeen,
        });
        await this.alerts.raise(outageAlert(liveness, now), now);
        continue;
      }
      // Recovery is keyed on the run being *over* — `notServingSince` cleared by
      // an admitting verdict — rather than on `outage` having gone false, which
      // it also does when an operator disables the endpoint or withdraws its
      // approval. Those end the alert; they do not mean the upstream came back.
      if (alerted !== undefined && row.notServingSince === null) {
        this.alerted.delete(row.id);
        alerts.recovered += 1;
        this.logger.log(recoveryLine(liveness, new Date(alerted), now));
        await this.recordEvent(row.id, 'recovered', {
          now,
          reason: `Serving again after ${durationSince(new Date(alerted), now)}.`,
          evidenceDigest: row.evidenceDigestSeen,
        });
        // The recovery goes out past the interval that governs declarations: an
        // operator who was woken is owed the "it is back" message, and withholding
        // it to protect the mailbox leaves them chasing an outage that ended.
        await this.alerts.raise(recoveryAlert(liveness, new Date(alerted), now), now, { urgent: true });
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
