import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, LessThan } from 'typeorm';
import { routerConfig } from '../config.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { snapshotsOnCurrentHostname } from './current-hostname.js';
import { type ParsedEvidenceBundle, parseEvidenceBundle } from './evidence-bundle.js';
import { fetchEvidenceBundle } from './evidence-fetcher.js';
import { type EvidenceState, evidenceStateOf } from './evidence-state.js';

/**
 * Evidence lives on the platform's ingress, not on a model backend, so it
 * answers in milliseconds when it answers at all. Ten seconds is long enough to
 * absorb a slow TLS handshake and short enough that one unreachable endpoint
 * cannot hold up a poll of the others.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * What a *read* waits for the publisher, when it finds nothing stored for the
 * hostname this deployment answers on (see {@link EvidenceService.refreshOwnIfUnknown}).
 *
 * Shorter than the poller's budget on purpose: this one is spent inside a console
 * query, where "not known yet" after two seconds is a better answer than a page
 * that hangs for ten.
 */
const ON_READ_FETCH_TIMEOUT_MS = 2_000;

/** How long a failed on-read attempt stands before another read tries again. */
const ON_READ_RETRY_AFTER_MS = 15_000;

/** One distinct thing an endpoint published, and the window it was current for. */
export interface DigestChange {
  evidenceDigest: string;
  evidenceDigestHex: string;
  firstIssuedAt: Date;
  lastIssuedAt: Date;
  snapshots: number;
}

export interface SnapshotPage {
  nodes: EvidenceSnapshot[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * Retrieval and storage of what the platform publishes for this router's own
 * endpoints (ADR-002, "How the router knows its own endpoints and digests").
 *
 * Nothing here decides whether a bundle is good; the service fetches, parses the
 * shape, and files the result. The console reads snapshots through it, and the
 * "Fetch fresh quote" button calls {@link refresh}.
 */
@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name);
  /** In-flight on-read refresh, shared so concurrent readers make one request. */
  private ownRefresh: Promise<void> | null = null;
  private ownRefreshFailedAt: Date | null = null;

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** The endpoints the config still lists: what the poller walks and the console shows. */
  async activeEndpoints(): Promise<Endpoint[]> {
    return this.dataSource.getRepository(Endpoint).find({ where: { enabled: true }, order: { name: 'ASC' } });
  }

  async endpointOrThrow(endpointId: string): Promise<Endpoint> {
    const endpoint = await this.dataSource.getRepository(Endpoint).findOne({ where: { id: endpointId } });
    if (!endpoint) {
      throw new NotFoundException(`Endpoint "${endpointId}" not found.`);
    }
    return endpoint;
  }

  async endpointByNameOrHostname(value: string): Promise<Endpoint | null> {
    const repository = this.dataSource.getRepository(Endpoint);
    return (await repository.findOne({ where: { name: value } })) ?? repository.findOne({ where: { hostname: value } });
  }

  /**
   * The endpoint that *is* this deployment — what `GET /v1/evidence` answers for.
   *
   * Resolved from `server.publicBaseUrl`, which is the address the service
   * publishes: on a router whose own API host is also an attested endpoint (every
   * deployment of this product so far, `api.router.superprotocol.com` included)
   * that hostname is the endpoint's, and the question has exactly one answer.
   *
   * The single-endpoint fallback is for the arrangement where it does not match
   * and still cannot be ambiguous: the compose stack and the e2e harness publish
   * on `127.0.0.1` while their one endpoint lives on a mock host's name. With two
   * or more endpoints and no hostname match there is no honest answer, so there
   * is none — the caller names the endpoint it means.
   */
  async ownEndpoint(): Promise<Endpoint | null> {
    const hostname = hostnameOf(this.config.server.publicBaseUrl);
    if (hostname) {
      const match = await this.dataSource.getRepository(Endpoint).findOne({ where: { hostname } });
      if (match) {
        return match;
      }
    }
    const enabled = await this.activeEndpoints();
    return enabled.length === 1 ? (enabled[0] as Endpoint) : null;
  }

  /**
   * Fetches the endpoint's bundle now and files it. Backs both the poller and
   * the console's "Fetch fresh quote"; the same call in both places is what
   * keeps the button from being a second, subtly different code path.
   */
  async refresh(endpoint: Endpoint, now: Date = new Date(), timeoutMs = FETCH_TIMEOUT_MS): Promise<EvidenceSnapshot> {
    const raw = await fetchEvidenceBundle(endpoint, { timeoutMs });
    const parsed = parseEvidenceBundle(raw, endpoint.hostname);
    return this.record(endpoint.id, parsed, now);
  }

  /**
   * Asks the publisher now, when nothing is stored for the hostname this
   * deployment answers on.
   *
   * A reconfigure that renames the deployment leaves the endpoint row in place
   * and its snapshots behind under the previous name, so the first read after a
   * cutover has nothing current to report. Waiting for the next poll leaves the
   * console saying "not published" for up to `evidence.pollInterval` about a
   * deployment that has been publishing all along; asking at the moment somebody
   * looks is the same convergence the platform's own hostname registry makes
   * (SUP-437).
   *
   * Never throws and never blocks for long: one shared request per cooldown, a
   * two-second budget, and a failure that leaves the read to answer "not known
   * yet" — which is what it would have answered anyway.
   */
  async refreshOwnIfUnknown(now: Date = new Date()): Promise<void> {
    if (this.ownRefresh) return this.ownRefresh;
    if (this.ownRefreshFailedAt && now.getTime() - this.ownRefreshFailedAt.getTime() < ON_READ_RETRY_AFTER_MS) {
      return;
    }

    this.ownRefresh = this.askOwnPublisher(now).finally(() => {
      this.ownRefresh = null;
    });
    return this.ownRefresh;
  }

  /**
   * Resolving the endpoint is inside the `try` with the fetch: both touch the
   * database, and the promise this backs is awaited by a read whose contract is
   * that it answers "not known yet" rather than failing.
   */
  private async askOwnPublisher(now: Date): Promise<void> {
    let own: Endpoint | null = null;
    try {
      own = await this.ownEndpoint();
      if (!own || (await this.latestFor(own.id))) return;

      await this.refresh(own, now, ON_READ_FETCH_TIMEOUT_MS);
      this.ownRefreshFailedAt = null;
    } catch (error) {
      this.ownRefreshFailedAt = now;
      if (own) {
        this.logFetchFailure(own, error);
      } else {
        this.logger.warn(`Could not work out which endpoint is this deployment's own: ${describe(error)}`);
      }
    }
  }

  /**
   * Stores a parsed bundle, idempotently on
   * `(endpointId, evidenceDigest, certFingerprint, issuedAt)`.
   *
   * That unique key is what makes the poller replica-safe without leader
   * election (ADR-002): every replica may poll the same endpoint at the same
   * time and the table still holds one row per publication. Re-observing a
   * publication moves `fetchedAt` forward — the console shows it as "checked
   * N ago" — but never adds a row.
   */
  async record(endpointId: string, parsed: ParsedEvidenceBundle, now: Date = new Date()): Promise<EvidenceSnapshot> {
    const repository = this.dataSource.getRepository(EvidenceSnapshot);
    const identity = {
      endpointId,
      evidenceDigest: parsed.digest.canonical,
      certFingerprint: parsed.certFingerprint,
      issuedAt: parsed.issuedAt,
    };

    const existing = await repository.findOne({ where: identity });
    if (existing) {
      // The hostname goes with `fetchedAt` rather than being left as first
      // filed: a row whose name is not the one it was just served under would be
      // skipped by the reads below, and a publication that was re-observed is
      // the opposite of one to hide.
      await repository.update({ id: existing.id }, { fetchedAt: now, hostname: parsed.hostname });
      existing.fetchedAt = now;
      existing.hostname = parsed.hostname;
      return existing;
    }

    const snapshot = repository.create({
      ...identity,
      id: randomUUID(),
      fetchedAt: now,
      hostname: parsed.hostname,
      evidenceDigestHex: parsed.digest.hex,
      quoteFormat: parsed.quoteFormat,
      containerImages: parsed.containerImages,
      workloads: parsed.workloads,
      chainSummary: parsed.chainSummary,
      measurements: parsed.measurements,
      jws: parsed.jws,
      bundle: parsed.bundle,
    });
    try {
      return await repository.save(snapshot);
    } catch (error) {
      // Lost the insert race with another replica: the row it wrote is the same
      // publication, so read it back instead of failing the poll.
      const raced = await repository.findOne({ where: identity });
      if (!raced) throw error;
      return raced;
    }
  }

  /**
   * The snapshot the console shows for an endpoint: the most recently issued one
   * of the hostname the endpoint answers on *now*.
   *
   * Scoped through {@link snapshotsOnCurrentHostname}, which is where the reason
   * is written down. "Not published yet" is the honest answer until the hostname
   * this endpoint answers on has published something (SUP-437).
   *
   * The history surfaces are deliberately not scoped: `snapshots` and
   * `digestHistory` are logs, each entry dated, and what a name published before
   * it was renamed is part of this endpoint's past rather than a claim about its
   * present.
   */
  async latestFor(endpointId: string): Promise<EvidenceSnapshot | null> {
    return snapshotsOnCurrentHostname(this.dataSource, [endpointId])
      .orderBy('snapshot.issuedAt', 'DESC')
      .addOrderBy('snapshot.fetchedAt', 'DESC')
      .limit(1)
      .getOne();
  }

  /** Same, for a list of endpoints — the Overview table's one query. */
  async latestForMany(endpointIds: string[]): Promise<Map<string, EvidenceSnapshot>> {
    const latest = new Map<string, EvidenceSnapshot>();
    if (endpointIds.length === 0) {
      return latest;
    }
    // Ordered ascending so that the last row written per endpoint is the newest;
    // a window function would be tighter but is not portable to SQLite.
    const rows = await snapshotsOnCurrentHostname(this.dataSource, endpointIds)
      .orderBy('snapshot.issuedAt', 'ASC')
      .addOrderBy('snapshot.fetchedAt', 'ASC')
      .getMany();
    for (const row of rows) {
      // Narrowing, not filtering: the `where` above names the ids, so a null here
      // would mean the query had picked up an upstream's publication.
      if (row.endpointId) {
        latest.set(row.endpointId, row);
      }
    }
    return latest;
  }

  async stateOf(endpointId: string, now: Date = new Date()): Promise<EvidenceState> {
    return this.stateOfSnapshot(await this.latestFor(endpointId), now);
  }

  /**
   * The published/stale/not-published verdict-free state of one snapshot.
   *
   * Lives here rather than in each caller because `evidence.freshnessWindow` is
   * what separates PUBLISHED from STALE, and a second copy of that lookup is a
   * second chance to read it from somewhere else.
   */
  stateOfSnapshot(snapshot: EvidenceSnapshot | null, now: Date = new Date()): EvidenceState {
    return evidenceStateOf(snapshot, this.config.evidence.freshnessWindow, now);
  }

  /**
   * Snapshots newest first, cursor-paginated on `issuedAt`.
   *
   * `after` is the opaque cursor from a previous page; a malformed one is
   * treated as absent rather than as an error, because a stale bookmark in the
   * console should re-open the first page, not break it.
   */
  async snapshots(endpointId: string, first = 20, after?: string | null): Promise<SnapshotPage> {
    const limit = Math.min(Math.max(first, 1), 100);
    const cursor = decodeCursor(after);
    const rows = await this.dataSource.getRepository(EvidenceSnapshot).find({
      where: cursor ? { endpointId, issuedAt: LessThan(cursor) } : { endpointId },
      order: { issuedAt: 'DESC', fetchedAt: 'DESC' },
      take: limit + 1,
    });
    const nodes = rows.slice(0, limit);
    const last = nodes.at(-1);
    return {
      nodes,
      hasNextPage: rows.length > limit,
      endCursor: last ? encodeCursor(last.issuedAt) : null,
    };
  }

  /**
   * The history the evidence modal shows: each distinct digest this endpoint has
   * published, newest first. Consecutive re-publications of the same deployment
   * collapse into one entry — what a user pinning a digest cares about is when
   * the value they pinned changed, not how often it was re-signed.
   */
  async digestHistory(endpointId: string, limit = 20): Promise<DigestChange[]> {
    const rows = await this.dataSource
      .getRepository(EvidenceSnapshot)
      .createQueryBuilder('snapshot')
      .select('snapshot.evidenceDigest', 'evidenceDigest')
      .addSelect('MAX(snapshot.evidenceDigestHex)', 'evidenceDigestHex')
      .addSelect('MIN(snapshot.issuedAt)', 'firstIssuedAt')
      .addSelect('MAX(snapshot.issuedAt)', 'lastIssuedAt')
      .addSelect('COUNT(snapshot.id)', 'snapshots')
      .where('snapshot.endpointId = :endpointId', { endpointId })
      .groupBy('snapshot.evidenceDigest')
      .orderBy('MAX(snapshot.issuedAt)', 'DESC')
      .limit(Math.min(Math.max(limit, 1), 100))
      .getRawMany<{
        evidenceDigest: string;
        evidenceDigestHex: string;
        firstIssuedAt: string | number;
        lastIssuedAt: string | number;
        snapshots: string | number;
      }>();

    return rows.map((row) => ({
      evidenceDigest: row.evidenceDigest,
      evidenceDigestHex: row.evidenceDigestHex,
      // Raw results bypass the column transformer, so the epoch milliseconds
      // come back as they are stored.
      firstIssuedAt: new Date(Number(row.firstIssuedAt)),
      lastIssuedAt: new Date(Number(row.lastIssuedAt)),
      snapshots: Number(row.snapshots),
    }));
  }

  /** Logs a failed poll once, at warn: an endpoint that publishes nothing is a state, not a crash. */
  logFetchFailure(endpoint: Endpoint, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`No evidence for endpoint "${endpoint.name}" (${endpoint.hostname}): ${message}`);
  }
}

/** An error reduced to one line, for a log that must not throw while writing it. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The host part of a configured URL, or null when it is not a URL at all. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Opaque page cursor for a snapshot; exported so an edge can carry its own. */
export function snapshotCursor(snapshot: Pick<EvidenceSnapshot, 'issuedAt'>): string {
  return encodeCursor(snapshot.issuedAt);
}

function encodeCursor(issuedAt: Date): string {
  return Buffer.from(String(issuedAt.getTime()), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): Date | null {
  if (!cursor) return null;
  const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isFinite(value) && value > 0 ? new Date(value) : null;
}
