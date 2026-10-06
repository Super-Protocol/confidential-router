import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { fetchEvidenceBundle, type ParsedEvidenceBundle, parseEvidenceBundle } from '../evidence/index.js';

/**
 * Same budget as the own-endpoint poller: evidence is served by the platform's
 * ingress, so ten seconds absorbs a slow handshake and still keeps one
 * unreachable upstream from holding up the rest of a pass.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** One endpoint's summary, keyed so a caller can ask for the digest it means. */
type ByDigest = Map<string, EvidenceSnapshot>;

export interface ExternalEvidenceReport {
  /** Endpoints that had a digest worth fetching and no snapshot for it yet. */
  polled: number;
  stored: number;
  /** Fetches that produced nothing storable — unreachable, unparseable, or unbound. */
  failed: number;
}

/**
 * What a cloud-level admission actually let in: the upstream's own published
 * bundle, filed so the admin section can render it (SUP-221 ruling 1, ADR-008 §7).
 *
 * **Informational, never gating.** Nothing here contributes to admission — that
 * is the measurement check in ADR-008 §3, performed by the sidecar, and this
 * service runs *after* it on an endpoint the sidecar has already admitted. It
 * exists because that check admits a *cloud* and cannot see which deployment on
 * it answered (threat T13), so an operator who is shown a verified chip and
 * nothing else is being told less than the design knows.
 *
 * **Why fetching again is not a second verification.** router-api fetches the
 * bundle over an ordinary TLS connection; it does not pin, and it must not, because
 * the one component allowed to hold a verdict about an upstream is the sidecar
 * (ADR-002's architectural rule, ADR-008 §1). What makes the result trustworthy
 * enough to render is a string comparison rather than a signature check: a bundle
 * is filed only when the leaf it claims is the leaf the sidecar pinned, and it is
 * only ever *surfaced* for the digest a verdict actually saw. A bundle served by
 * anyone but that upstream fails the first test; a stale real bundle replayed by
 * that upstream fails the second.
 *
 * Nothing is persisted that could be mistaken for trust: the rows are
 * `evidence_snapshots`, which by construction records what was published and never
 * whether it was any good (`evidence-snapshot.entity.ts`).
 */
@Injectable()
export class ExternalEvidenceService {
  private readonly logger = new Logger(ExternalEvidenceService.name);

  /**
   * The one publication per endpoint that was tried and found wanting, so a pass
   * does not re-fetch a bundle that just refused to parse every minute for ever.
   *
   * One entry per endpoint rather than a set of every failure, which is both the
   * behaviour wanted and what bounds the map: the question is only ever "is this
   * the publication that already failed?", and an upstream that keeps publishing
   * fresh broken bundles should keep being asked — each new digest is a new
   * publication. Dropped on success, because whatever was wrong is no longer the
   * upstream's current state.
   */
  private readonly refused = new Map<string, string>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * One pass over every upstream whose last verdict admitted it.
   *
   * `pending` and `denied` endpoints are skipped, and that is the honest
   * behaviour rather than a shortcut: without a verdict there is no pinned leaf
   * to bind a fetched bundle to, so anything retrieved would be a document from
   * an unauthenticated host rendered beside a measurement — exactly the
   * confusion ruling 1's "informational" label is meant to prevent.
   */
  async refreshAll(now: Date = new Date()): Promise<ExternalEvidenceReport> {
    const report: ExternalEvidenceReport = { polled: 0, stored: 0, failed: 0 };
    const endpoints = await this.dataSource.getRepository(ExternalEndpoint).find({
      where: { enabled: true, status: 'verified' },
    });

    for (const endpoint of endpoints) {
      const digest = endpoint.evidenceDigestSeen;
      const pin = endpoint.pinnedCertFingerprint;
      if (!digest || !pin || this.refused.get(endpoint.id) === digest) {
        continue;
      }
      if (await this.has(endpoint.id, digest)) {
        continue;
      }
      report.polled += 1;
      try {
        await this.refresh(endpoint, now);
        report.stored += 1;
      } catch (error) {
        report.failed += 1;
        this.refused.set(endpoint.id, digest);
        this.logger.warn(
          `No evidence summary for external endpoint "${endpoint.name}": ${
            error instanceof Error ? error.message : String(error)
          }.`,
        );
      }
    }
    return report;
  }

  /**
   * Fetches one upstream's bundle and files it, or throws.
   *
   * The binding check is the whole of this method's judgement, and it is
   * deliberately the weakest one that is still sound: *is the leaf this document
   * claims the leaf the sidecar pinned?* If it is, the document came from the
   * channel the verdict was about. If it is not, it is filed nowhere and rendered
   * nowhere, whatever else is true of it.
   */
  async refresh(endpoint: ExternalEndpoint, now: Date = new Date()): Promise<EvidenceSnapshot> {
    const raw = await fetchEvidenceBundle({ hostname: endpoint.hostname }, { timeoutMs: FETCH_TIMEOUT_MS });
    const parsed = parseEvidenceBundle(raw, endpoint.hostname);
    if (parsed.certFingerprint !== endpoint.pinnedCertFingerprint) {
      throw new Error(
        `the bundle claims the TLS leaf ${parsed.certFingerprint} and the egress is pinned to ` +
          `${endpoint.pinnedCertFingerprint}, so it is not a document about the channel this verdict covers`,
      );
    }
    const stored = await this.record(endpoint.id, parsed, now);
    // Whatever was wrong with an earlier publication of this upstream is no
    // longer its current state.
    this.forget(endpoint.id);
    return stored;
  }

  /**
   * The snapshots behind a set of (endpoint, digest) pairs, in one query.
   *
   * The resolver asks for exactly the digests it will render — each endpoint's
   * `evidenceDigestSeen` plus the digest on every timeline entry — rather than
   * for an endpoint's whole history, which grows by one row per publication and
   * is not what any screen shows.
   */
  async summariesFor(
    wanted: Iterable<{ externalEndpointId: string; evidenceDigest: string }>,
  ): Promise<Map<string, ByDigest>> {
    const pairs = [...wanted];
    const byEndpoint = new Map<string, ByDigest>();
    if (pairs.length === 0) {
      return byEndpoint;
    }

    const rows = await this.dataSource.getRepository(EvidenceSnapshot).find({
      where: {
        externalEndpointId: In([...new Set(pairs.map((pair) => pair.externalEndpointId))]),
        evidenceDigest: In([...new Set(pairs.map((pair) => pair.evidenceDigest))]),
      },
      order: { issuedAt: 'ASC', fetchedAt: 'ASC' },
    });

    for (const row of rows) {
      if (!row.externalEndpointId) continue;
      const digests = byEndpoint.get(row.externalEndpointId) ?? new Map<string, EvidenceSnapshot>();
      // Ascending order above means the last write wins, which is the most
      // recently issued publication carrying this digest — a re-issue of the same
      // snapshot is the same facts with a newer signature.
      digests.set(row.evidenceDigest, row);
      byEndpoint.set(row.externalEndpointId, digests);
    }
    return byEndpoint;
  }

  /** Drops the negative cache for one endpoint, so its next publication is asked for again. */
  forget(externalEndpointId: string): void {
    this.refused.delete(externalEndpointId);
  }

  private async has(externalEndpointId: string, evidenceDigest: string): Promise<boolean> {
    return (
      (await this.dataSource
        .getRepository(EvidenceSnapshot)
        .findOne({ where: { externalEndpointId, evidenceDigest }, select: { id: true } })) !== null
    );
  }

  /**
   * Stores a parsed upstream bundle, idempotently on
   * `(externalEndpointId, evidenceDigest, certFingerprint, issuedAt)`.
   *
   * The own-endpoint key with the other discriminator
   * (`IDX_evidence_snapshots_external_identity`), and for the same reason: every
   * replica may poll the same upstream and the table still holds one row per
   * publication. Re-observing one moves `fetchedAt` forward and adds nothing.
   */
  private async record(externalEndpointId: string, parsed: ParsedEvidenceBundle, now: Date): Promise<EvidenceSnapshot> {
    const repository = this.dataSource.getRepository(EvidenceSnapshot);
    const identity = {
      externalEndpointId,
      evidenceDigest: parsed.digest.canonical,
      certFingerprint: parsed.certFingerprint,
      issuedAt: parsed.issuedAt,
    };

    const existing = await repository.findOne({ where: identity });
    if (existing) {
      await repository.update({ id: existing.id }, { fetchedAt: now });
      existing.fetchedAt = now;
      return existing;
    }

    const snapshot = repository.create({
      ...identity,
      id: randomUUID(),
      // Stated, not defaulted: the XOR with `externalEndpointId` is what keeps an
      // upstream's publications out of our own endpoints' digest history
      // (`evidenceSnapshotEndpointIsExclusive`).
      endpointId: null,
      fetchedAt: now,
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
      const raced = await repository.findOne({ where: identity });
      if (!raced) throw error;
      return raced;
    }
  }
}
