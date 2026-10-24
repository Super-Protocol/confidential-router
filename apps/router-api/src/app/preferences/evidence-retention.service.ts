import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { routerConfig } from '../config.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { Generation } from '../db/entities/generation.entity.js';
import { UserPreferences } from '../db/entities/user-preferences.entity.js';
import { EvidenceRetentionHealth } from './evidence-retention-health.js';
import { DEFAULT_RETENTION_DAYS } from './preferences.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many snapshots one pass may strip.
 *
 * A deployment that has never swept has a backlog the size of its whole history,
 * and emptying it in one statement would be a single long write on the table the
 * poller and every evidence screen read. The backlog drains over as many passes
 * as it takes, oldest first, and a steady state never comes near the cap.
 */
const MAX_STRIPPED_PER_PASS = 2_000;

/**
 * How many candidate rows are classified at a time.
 *
 * The *write* is what has to be capped; the read must not be, and capping it was
 * a stall waiting to happen — a contiguous run of rows held by one long-window
 * account would have filled every pass's candidate set forever and the rows
 * behind them would never have been reached. So the pass pages through the whole
 * eligible range with a keyset cursor and stops on the strip budget instead. The
 * range shrinks as the sweep catches up: a stripped row leaves it permanently.
 */
const CANDIDATE_PAGE = 2_000;

/** A keyset cursor over `(issuedAt, id)`, which is the candidate order. */
interface Cursor {
  issuedAt: number;
  id: string;
}

export interface SweepOptions {
  /**
   * Candidate rows per page. Overridable only so a test can prove that the
   * cursor advances across pages — the property that keeps a run of held rows
   * from blocking everything behind it — without seeding {@link CANDIDATE_PAGE}
   * rows to do it. Production always uses the constant.
   */
  pageSize?: number;
}

/**
 * The longest window any holder of a group has set, over the holders that are
 * still holding anything.
 *
 * Three cases, in the order the `CASE` reads them (SUP-525):
 *
 * - `preferences.userId IS NULL` — the `LEFT JOIN` missed, so this holder has
 *   never opened Preferences and is still promised the published period.
 * - `NOT preferences.archiveEvidence` — the holder has opted out of keeping
 *   archived bundles, so it contributes `NULL`, which `MAX` ignores. An account
 *   that is not holding the publication must not be what keeps it, and its
 *   stored window — which it cannot even reach while the switch is off — must
 *   not count toward the maximum.
 * - otherwise — the window it stored.
 *
 * `MAX` over holders that all opted out is therefore `NULL`, and
 * {@link holderWindowDays} reads that as "nobody holds this". That is a
 * different answer from a snapshot no holder query returned at all, which keeps
 * the published default.
 *
 * Written without a boolean literal on purpose: `TRUE`/`FALSE` are `1`/`0` on
 * SQLite and the same expression has to run on both drivers. `NOT <column>`
 * does, and `IS NULL` carries the join miss.
 */
const HOLDER_WINDOW_DAYS =
  'MAX(CASE WHEN preferences.userId IS NOT NULL AND NOT preferences.archiveEvidence THEN NULL ' +
  `ELSE COALESCE(preferences.evidenceRetentionDays, ${DEFAULT_RETENTION_DAYS}) END)`;

/**
 * One holder-window row's answer, in days.
 *
 * `NULL` is the opt-out answer — every account that holds the publication has
 * `archiveEvidence` off, so nobody is holding it and its window closed when it
 * was published. Recorded as `0` rather than left out of the map, because left
 * out means something else: held by nobody at all, which keeps the published
 * default.
 */
function holderWindowDays(days: number | string | null | undefined): number {
  // `undefined` as well as `null`: an aggregate over no non-NULL input is NULL,
  // and which of the two a driver hands back for it is not worth depending on.
  if (days === null || days === undefined) return 0;
  const parsed = Number(days);
  // Not finite: an arithmetic accident must not fail in the direction that
  // deletes, so it falls back to the published period — the same direction
  // `sweep` errs in for a row no holder query spoke for.
  return Number.isFinite(parsed) ? parsed : DEFAULT_RETENTION_DAYS;
}

export interface SweepReport {
  /** Rows past the earliest window anyone could have set, so worth a decision. */
  examined: number;
  /** Rows whose payload this pass removed. */
  stripped: number;
  /** Rows left because a live surface still hands their bundle out. */
  inUse: number;
  /** Rows left because the longest window held by an account that has them is still open. */
  held: number;
}

/** A candidate row, reduced to what the decision needs. */
interface Candidate {
  id: string;
  endpointId: string | null;
  externalEndpointId: string | null;
  evidenceDigest: string;
  issuedAt: Date;
}

/**
 * Enforces `UserPreferences.evidenceRetentionDays` by removing the bundle and
 * the JWS of publications past their window, and keeping the digests (SUP-498).
 *
 * This is the job `/privacy`'s attestation row describes and the job
 * `EvidenceSnapshot.jws` / `.bundle` were annotated for from the start. Until
 * this service existed, the period was published, the setting was offered and
 * stored, and no code read the number — raw bundles accumulated for the life of
 * the deployment (GDPR Art. 5(1)(e), with the stated period of Art. 13(2)(a) on
 * top of it).
 *
 * ## Whose preference governs a row
 *
 * The published period is per account; the table is per *publication*. An
 * `evidence_snapshots` row belongs to an endpoint or to an external upstream, and
 * on a deployment with one model and many users the same row is the archived
 * evidence of every account that was served under it. There is no owning user to
 * read a single preference from, so the rule is the one under which no account's
 * setting is quietly shortened:
 *
 * **A publication is strippable only once it is past the window of every account
 * that holds it** — `issuedAt + max(evidenceRetentionDays)` over its holders, the
 * schema default for an account that has never changed the setting, and the
 * default again for a publication no account holds at all (polled, never served,
 * so nobody's archive — and the one case where keeping it forever would be
 * storage with no promise attached).
 *
 * An account holds a publication when a generation of its workspace was served
 * under it: `Generation.evidenceSnapshotId` for this deployment's own endpoints,
 * and `(externalEndpointId, evidenceDigest)` for an upstream's, which is the same
 * two paths `EvidenceExportService` resolves an audit archive through.
 *
 * ## Opting out of holding
 *
 * `UserPreferences.archiveEvidence` is that rule's one modifier (SUP-525). The
 * console offers it as a switch, so it has to mean something, and the only thing
 * it can honestly mean on a per-publication table is **this account is not one of
 * the holders**: it contributes nothing to the maximum instead of its window.
 *
 * A publication only opted-out accounts hold is then past its window immediately
 * and goes on the next pass; one an opted-in account also holds stays until that
 * account's window closes, which is the only correct answer — a row is the
 * archived evidence of every account served under it, and one account's switch
 * cannot remove a document other accounts are still promised.
 *
 * So the switch is an opt-out of *holding*, not a delete button and not a filter
 * on the poller: `EvidencePollerService` keeps filing every bundle it fetches,
 * because the bundle of the publication serving right now is what
 * `GET /v1/evidence/{endpoint}` relays and what `/v1/models` reads the TEE out
 * of, and no user preference can switch those off.
 *
 * ## What is never stripped
 *
 * The *live* publication of an endpoint, whatever its age: `GET /v1/evidence/{endpoint}`
 * relays it, `GET /v1/models` reads the TEE out of it and the console's badge
 * renders it. Those readers are not archive readers — they are answering "what is
 * running right now" — and a retention sweep that emptied them would turn a
 * privacy promise into an outage. Two exemptions cover them, one per publisher
 * kind, because the two resolve "live" differently: for one of this deployment's
 * own endpoints it is the newest row (`EvidenceService.latestFor`), and for an
 * external upstream it is the row carrying the digest an admin pinned and a
 * verdict saw, which can be older than one that superseded it
 * (`ExternalEvidenceService.latestAdmitted`).
 *
 * ## Replica safety
 *
 * No leader election, for the same reason the poller needs none (ADR-002): the
 * write is idempotent. `UPDATE … SET jws = NULL WHERE id IN (…) AND
 * payloadStrippedAt IS NULL` converges however many replicas run it, and the
 * second one to arrive strips nothing and says so in its count.
 */
@Injectable()
export class EvidenceRetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EvidenceRetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly health: EvidenceRetentionHealth,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.evidence.retentionSweepInterval;
    if (interval <= 0) {
      // Said at `warn`, not `log`: a deployment with the sweep switched off is
      // publishing a retention period it does not keep, which is the state
      // SUP-498 was filed about.
      this.logger.warn(
        'The evidence retention sweep is disabled (evidence.retentionSweepInterval is 0). ' +
          'Archived bundles will accumulate regardless of UserPreferences.evidenceRetentionDays.',
      );
      return;
    }
    this.health.sweepScheduled();
    // Not awaited: boot must not wait on a table scan. The first pass runs on the
    // next tick.
    void this.runPass();
    this.timer = setInterval(() => void this.runPass(), interval);
    // Node keeps the process alive for a pending timer; a sweep must not be the
    // reason a container refuses to exit.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass, with its outcome logged and recorded for `/health`.
   *
   * Public for the same reason `EvidencePollerService.pollAll` is: a test — and
   * any future admin trigger — awaits a real pass rather than sleeping for one.
   * {@link sweep} is the pass without the observability; this is the pass as the
   * timer runs it, and the one worth asserting against.
   */
  async runPass(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skipping the evidence retention sweep: the previous pass is still running.');
      return;
    }
    this.running = true;
    try {
      const now = new Date();
      const report = await this.sweep(now);
      this.health.passCompleted(report.stripped, now);
      // Logged on every pass, including the quiet ones. "Stripped 0 of 0" is the
      // line that answers "is the sweep running at all", and a sweep nobody can
      // observe is how the setting came to do nothing for a whole preview.
      this.logger.log(
        `Evidence retention: stripped ${report.stripped} of ${report.examined} snapshot(s) past the window ` +
          `(${report.held} still held by an account's preference, ${report.inUse} serving a live endpoint).`,
      );
    } catch (error) {
      this.health.passFailed();
      const message = error instanceof Error ? error.message : String(error);
      // A failed pass is a warning, never a thrown error: the next one retries,
      // and an unhandled rejection out of a timer takes the process down.
      this.logger.warn(`Evidence retention sweep failed: ${message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One pass over the publications past their window.
   *
   * The pure half: it decides and writes, and says what it did. {@link runPass}
   * is the half that logs and records; a caller that wants the numbers takes
   * them from here.
   */
  async sweep(now: Date = new Date(), options: SweepOptions = {}): Promise<SweepReport> {
    const pageSize = options.pageSize ?? CANDIDATE_PAGE;
    const shortest = await this.shortestWindowDays();
    // Nothing younger than the shortest window in play can be past anyone's, so
    // this is where the candidate range starts — and it is what keeps the pass
    // off the rows that are obviously still inside everybody's period.
    const cutoff = now.getTime() - shortest * DAY_MS;
    const report: SweepReport = { examined: 0, stripped: 0, inUse: 0, held: 0 };
    // One read for the whole pass: the live set is a handful of rows and does
    // not change under us in any way that would make a page's decision wrong.
    const inUse = await this.liveSnapshotIds();
    let cursor: Cursor | null = null;

    while (report.stripped < MAX_STRIPPED_PER_PASS) {
      const page = await this.candidatePage(cutoff, cursor, pageSize);
      const last = page.at(-1);
      if (!last) break;
      cursor = { issuedAt: last.issuedAt.getTime(), id: last.id };
      report.examined += page.length;

      const windows = await this.windowDaysOf(page);
      const strip: string[] = [];
      for (const candidate of page) {
        if (inUse.has(candidate.id)) {
          report.inUse += 1;
          continue;
        }
        // `Number.isFinite` and not just `??`: a `NaN` window would make the
        // comparison below `false` and strip the row, and an arithmetic
        // accident must not fail in the direction that deletes. Unreachable
        // through a `NOT NULL` integer bounded 1–3650, and the guard is free.
        //
        // `0` *is* reachable, and is meant to strip: it is what `windowDaysOf`
        // answers for a publication every one of whose holders has opted out of
        // holding it (SUP-525).
        const stored = windows.get(candidate.id);
        const days = stored !== undefined && Number.isFinite(stored) ? stored : DEFAULT_RETENTION_DAYS;
        if (candidate.issuedAt.getTime() + days * DAY_MS > now.getTime()) {
          report.held += 1;
          continue;
        }
        strip.push(candidate.id);
      }
      report.stripped += await this.stripPayloads(strip, now);
    }
    return report;
  }

  /** Empties the two documents of the named rows, in bounded statements. */
  private async stripPayloads(ids: string[], now: Date): Promise<number> {
    let stripped = 0;
    for (const batch of chunks(ids, 200)) {
      const result = await this.dataSource
        .createQueryBuilder()
        .update(EvidenceSnapshot)
        .set({ jws: null, bundle: null, payloadStrippedAt: now })
        .where('id IN (:...ids)', { ids: batch })
        // `payloadStrippedAt IS NULL` in the predicate, not just in the read
        // that selected these ids: another replica may have swept the same row
        // in between, and this is what keeps the recorded strip time the first
        // one's.
        //
        // Written as SQL rather than as `{ payloadStrippedAt: IsNull() }`,
        // because `timestampColumn`'s transformer runs over an update's criteria
        // and has no epoch to convert a `FindOperator` to.
        .andWhere('payloadStrippedAt IS NULL')
        .execute();
      stripped += result.affected ?? batch.length;
    }
    return stripped;
  }

  /**
   * One page of rows old enough that *somebody's* window could have closed on
   * them, oldest first, after the cursor.
   *
   * Keyset-paginated on `(issuedAt, id)` rather than `OFFSET`: the pass strips
   * rows as it goes, so every row it removes would shift an offset underneath it
   * and skip a row. `id` is in the key because `issuedAt` is not unique — several
   * endpoints can publish in the same millisecond, and a cursor that only carried
   * the timestamp would either repeat a row or lose one.
   *
   * `IDX_evidence_snapshots_retention` is this query's index.
   */
  private async candidatePage(cutoff: number, cursor: Cursor | null, pageSize: number): Promise<Candidate[]> {
    const query = this.dataSource
      .getRepository(EvidenceSnapshot)
      .createQueryBuilder('snapshot')
      .select([
        'snapshot.id',
        'snapshot.endpointId',
        'snapshot.externalEndpointId',
        'snapshot.evidenceDigest',
        'snapshot.issuedAt',
      ])
      .where('snapshot.payloadStrippedAt IS NULL')
      .andWhere('snapshot.issuedAt <= :cutoff', { cutoff })
      .orderBy('snapshot.issuedAt', 'ASC')
      .addOrderBy('snapshot.id', 'ASC')
      .limit(pageSize);
    if (cursor) {
      query.andWhere(
        '(snapshot.issuedAt > :afterIssuedAt OR (snapshot.issuedAt = :afterIssuedAt AND snapshot.id > :afterId))',
        {
          afterIssuedAt: cursor.issuedAt,
          afterId: cursor.id,
        },
      );
    }
    return query.getMany();
  }

  /**
   * The shortest window anybody could be holding a publication for, which is
   * where the candidate range starts.
   *
   * An account with `archiveEvidence` off counts as `0` (SUP-525): a publication
   * only such accounts hold is past its window the moment it is published, and a
   * prefilter that started 90 days back would never offer it to the pass. So one
   * opt-out anywhere on the deployment widens the candidate range to the whole
   * unstripped table — an indexed, keyset-paged, oldest-first read whose write is
   * still capped by {@link MAX_STRIPPED_PER_PASS}, and the only range in which
   * the opt-out can mean what the console says it means.
   */
  private async shortestWindowDays(): Promise<number> {
    const row = await this.dataSource
      .getRepository(UserPreferences)
      .createQueryBuilder('preferences')
      .select(
        'MIN(CASE WHEN NOT preferences.archiveEvidence THEN 0 ELSE preferences.evidenceRetentionDays END)',
        'days',
      )
      .getRawOne<{ days: number | string | null }>();
    const stored = Number(row?.days ?? Number.NaN);
    // The default is always in play: an account that has never opened Preferences
    // has no row, and the window it is promised is the column default.
    return Number.isFinite(stored) ? Math.min(stored, DEFAULT_RETENTION_DAYS) : DEFAULT_RETENTION_DAYS;
  }

  /**
   * The longest window held by any account, per candidate snapshot — `0` for a
   * publication whose holders have all opted out of holding anything.
   *
   * Two queries because there are two ways a generation names its publication,
   * and they are the two `EvidenceExportService` reads an audit archive through.
   * A snapshot missing from the result is held by nobody — the caller falls back
   * to the default rather than treating it as "retain forever". A snapshot
   * *present* with `0` is held by nobody either, but for the other reason: every
   * holder has `archiveEvidence` off. See {@link HOLDER_WINDOW_DAYS}.
   *
   * `LEFT JOIN user_preferences` with a default for the miss, because a user who
   * has never changed the setting has no row and is still promised the published
   * period. The join to `workspace_members` is what turns a workspace's
   * generation into the accounts whose archive it is.
   */
  private async windowDaysOf(candidates: Candidate[]): Promise<Map<string, number>> {
    const windows = new Map<string, number>();
    const own = candidates.filter((candidate) => candidate.endpointId !== null).map((candidate) => candidate.id);
    const external = candidates.filter((candidate) => candidate.externalEndpointId !== null);

    if (own.length > 0) {
      for (const batch of chunks(own, 500)) {
        const rows = await this.holderWindows()
          .select('generation.evidenceSnapshotId', 'key')
          .addSelect(HOLDER_WINDOW_DAYS, 'days')
          .where('generation.evidenceSnapshotId IN (:...ids)', { ids: batch })
          .groupBy('generation.evidenceSnapshotId')
          .getRawMany<{ key: string; days: number | string | null }>();
        for (const row of rows) {
          windows.set(row.key, holderWindowDays(row.days));
        }
      }
    }

    if (external.length > 0) {
      const byPair = new Map(external.map((c) => [`${c.externalEndpointId}\u0000${c.evidenceDigest}`, c.id]));
      for (const batch of chunks(external, 500)) {
        const rows = await this.holderWindows()
          .select('generation.externalEndpointId', 'endpointId')
          .addSelect('generation.evidenceDigest', 'digest')
          .addSelect(HOLDER_WINDOW_DAYS, 'days')
          .where('generation.externalEndpointId IN (:...endpointIds)', {
            endpointIds: [...new Set(batch.map((candidate) => candidate.externalEndpointId))],
          })
          .andWhere('generation.evidenceDigest IN (:...digests)', {
            digests: [...new Set(batch.map((candidate) => candidate.evidenceDigest))],
          })
          .groupBy('generation.externalEndpointId')
          .addGroupBy('generation.evidenceDigest')
          .getRawMany<{ endpointId: string; digest: string; days: number | string | null }>();
        for (const row of rows) {
          // The two `IN` lists above are a cross product, so a pair that no
          // candidate names can come back; matching on the pair is what discards it.
          const id = byPair.get(`${row.endpointId}\u0000${row.digest}`);
          if (id) {
            windows.set(id, holderWindowDays(row.days));
          }
        }
      }
    }
    return windows;
  }

  /**
   * The shared half of both holder queries: workspace → members → their window.
   *
   * Selects nothing: each caller names its own grouping key and then adds
   * {@link HOLDER_WINDOW_DAYS}, because `select()` replaces the list rather than
   * extending it.
   */
  private holderWindows() {
    return this.dataSource
      .getRepository(Generation)
      .createQueryBuilder('generation')
      .innerJoin('workspace_members', 'member', 'member.workspaceId = generation.workspaceId')
      .leftJoin('user_preferences', 'preferences', 'preferences.userId = member.userId');
  }

  /**
   * Snapshots a live surface still hands the bundle out of, and which the sweep
   * therefore leaves alone however old they are.
   *
   * A deliberate superset of what those surfaces reach, and a different query per
   * publisher kind rather than one that looks the same for both.
   *
   * For one of our own endpoints the live row is the newest, which is what
   * `latestFor` / `latestForMany` return. For an external upstream it is **not**:
   * `latestAdmitted` keys on `evidenceDigestSeen` once an admin has pinned it, so
   * a publication the upstream has since superseded can be the one the relay
   * hands out — while the row that superseded it, whose bundle no surface reads,
   * is ordinary archive. Exempting the newest external row as well would have
   * spared exactly the rows an upstream accumulates fastest.
   *
   * Erring wide costs a few rows of storage; erring narrow empties the bundle
   * `GET /v1/evidence` is serving.
   *
   * **One query per endpoint, deliberately.** The single-query form is
   * `latestForMany`'s — read every snapshot of every endpoint in ascending order
   * and let the last write win — and it loads the whole history to find one row
   * per endpoint, which is the table this sweep exists because it grows. A
   * `LIMIT 1` per endpoint reads one row per endpoint instead. The bound is the
   * endpoint count: two on production, and a deployment with twenty would do
   * twenty indexed single-row lookups once every six hours.
   */
  private async liveSnapshotIds(): Promise<Set<string>> {
    const snapshots = this.dataSource.getRepository(EvidenceSnapshot);
    const live = new Set<string>();

    const endpoints = await this.dataSource.getRepository(Endpoint).find({ select: ['id'] });
    for (const endpoint of endpoints) {
      const newest = await snapshots.findOne({
        where: { endpointId: endpoint.id },
        order: { issuedAt: 'DESC', fetchedAt: 'DESC' },
        select: ['id'],
      });
      if (newest) live.add(newest.id);
    }

    const externals = await this.dataSource
      .getRepository(ExternalEndpoint)
      .find({ select: ['id', 'pinnedEvidenceDigest', 'evidenceDigestSeen'] });
    for (const endpoint of externals) {
      // Both digests, not just the pinned one: `latestAdmitted` requires them to
      // agree, and between an upstream republishing and an admin re-pinning they
      // can disagree in either direction. Holding both costs two rows.
      const digests = [endpoint.pinnedEvidenceDigest, endpoint.evidenceDigestSeen].filter(
        (digest): digest is string => typeof digest === 'string' && digest.length > 0,
      );
      if (digests.length === 0) continue;
      const admitted = await snapshots.find({
        where: { externalEndpointId: endpoint.id, evidenceDigest: In([...new Set(digests)]) },
        select: ['id'],
      });
      for (const row of admitted) live.add(row.id);
    }
    return live;
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
