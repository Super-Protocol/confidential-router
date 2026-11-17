import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not } from 'typeorm';
import { OperatorAlertsService } from '../alerts/operator-alerts.service.js';
import { routerConfig } from '../config.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
// The leaf modules rather than `../evidence/index.js`, and not as a style
// preference: that barrel re-exports `EvidenceModule`, whose controller relays
// *this* service's stored bundles (SUP-227). Going through it would close an
// import cycle whose only symptom is a Nest provider that is `undefined` at
// decorator-evaluation time — "the argument at index [1] is available in the
// current module?" pointing at a module that has nothing wrong with it.
import { type ParsedEvidenceBundle, parseEvidenceBundle } from '../evidence/evidence-bundle.js';
import { EVIDENCE_PATH, EvidenceFetchError, fetchEvidenceBundle } from '../evidence/evidence-fetcher.js';
// The leaf module, for the import-cycle reason above: `./index.js` re-exports
// this service.
import { durationSince } from './external-endpoint-liveness.js';

/**
 * Same budget as the own-endpoint poller: evidence is served by the platform's
 * ingress, so ten seconds absorbs a slow handshake and still keeps one
 * unreachable upstream from holding up the rest of a pass.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** One endpoint's summary, keyed so a caller can ask for the digest it means. */
type ByDigest = Map<string, EvidenceSnapshot>;

export interface ExternalEvidenceReport {
  /** Endpoints this pass asked, because their filed copy was missing or due a refresh. */
  polled: number;
  stored: number;
  /** Fetches that produced nothing storable — unreachable, unparseable, or unbound. */
  failed: number;
  /**
   * Endpoints whose relayed publication is past `evidenceStaleAfter` — a count
   * rather than a flag because the poller logs it and one upstream's stale copy
   * says nothing about the next one's (SUP-615).
   */
  stale: number;
}

/**
 * What a cloud-level admission actually let in: the upstream's own published
 * bundle, filed so the admin section can render it (SUP-221 ruling 1, ADR-008 §7).
 *
 * **Informational, never gating.** Nothing here contributes to admission — that
 * is the two-factor check (ADR-008 §3 as amended by SUP-252), performed by the
 * sidecar, and this service runs *after* it on an endpoint whose evidence the
 * sidecar has already verified. It is what an admin reads before pinning a
 * deployment's digest: the workloads and images that digest stands for.
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
   * Per endpoint, the `evidenceDigestSeen` this process last asked about and
   * when — so a poll every minute does not keep asking the same question, and so
   * that it does eventually ask it again.
   *
   * It records an answer on three outcomes, and it is worth naming which: the
   * publication was filed; the upstream served something that cannot be bound to
   * this verdict's pin; or the upstream has already moved on and a fetch returns
   * a *different* digest, which is the case that would otherwise re-fetch every
   * minute until the sidecar's next re-attestation caught up. It records
   * **nothing** on a transport failure — an upstream mid-restart is unreachable,
   * not wrong, and one 503 must not suppress its summary until it next redeploys.
   *
   * The timestamp is the SUP-615 half. A digest-only latch is permanent for as
   * long as a deployment stands, because the digest says *what* is deployed and
   * only `issuedAt` says *when* the upstream last asserted it — so this router
   * filed one copy, relayed it for 37 hours, and every verifier correctly
   * refused a bundle signed the day before while the upstream was publishing a
   * one-minute-old one. `evidenceRefreshAfter` is how long an answer stands
   * before the question is worth asking again.
   *
   * One entry per endpoint, so the map is bounded by the registration count, and
   * a new verdict digest is a different value and therefore a new question.
   */
  private readonly asked = new Map<string, { digest: string; at: number }>();

  /**
   * Per endpoint, the `issuedAt` of the relayed publication this process has
   * already declared stale — the latch that makes the alert fire once per run
   * rather than once per minute (`alertOnOutages`' `alerted`, SUP-517).
   *
   * Keyed on the publication rather than on a boolean so that a relay which
   * recovers and then falls behind again is a second run and earns a second
   * message; and cleared when the copy is fresh again, which is what sends the
   * "it is back" line an operator who was woken is owed.
   */
  private readonly declaredStale = new Map<string, number>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly alerts: OperatorAlertsService,
  ) {}

  /**
   * One pass over every upstream whose last report's cryptography held.
   *
   * That is every admitted endpoint, and also every endpoint a two-factor trust
   * factor refused (SUP-252): `digest-not-pinned` on a fresh registration,
   * `digest-mismatch` after a redeploy. Those are exactly the moments an admin is
   * asked to approve a deployment, so they are the moments its evidence summary
   * matters most. What is skipped is any endpoint with no observed leaf — no
   * report yet, or a report that failed in the pipeline (fetch, chain, root,
   * channel binding) — and that is the honest behaviour rather than a shortcut:
   * without a leaf the sidecar observed there is nothing to bind a fetched bundle
   * to, so anything retrieved would be a document from an unauthenticated host
   * rendered beside a measurement.
   */
  async refreshAll(now: Date = new Date()): Promise<ExternalEvidenceReport> {
    const report: ExternalEvidenceReport = { polled: 0, stored: 0, failed: 0, stale: 0 };
    const endpoints = await this.dataSource.getRepository(ExternalEndpoint).find({
      where: { enabled: true, observedCertFingerprint: Not(IsNull()) },
    });

    for (const endpoint of endpoints) {
      const digest = endpoint.evidenceDigestSeen;
      if (!digest || !endpoint.observedCertFingerprint) {
        continue;
      }
      if (await this.due(endpoint.id, digest, now)) {
        report.polled += 1;
        try {
          await this.refresh(endpoint, now);
          report.stored += 1;
          // Asked under whatever digest came back. When it is not the one this
          // verdict names, the upstream republished between the sidecar's check
          // and this fetch — the publication the verdict named is gone and asking
          // again before `evidenceRefreshAfter` cannot produce it; the next
          // verdict will name the new one.
          this.asked.set(endpoint.id, { digest, at: now.getTime() });
        } catch (error) {
          report.failed += 1;
          if (!(error instanceof EvidenceFetchError)) {
            this.asked.set(endpoint.id, { digest, at: now.getTime() });
          }
          this.logger.warn(
            `No evidence summary for external endpoint "${endpoint.name}": ${
              error instanceof Error ? error.message : String(error)
            }.`,
          );
        }
      }
      if (await this.reportStaleRelay(endpoint, now)) {
        report.stale += 1;
      }
    }
    return report;
  }

  /**
   * Whether this pass should ask this upstream for its bundle again.
   *
   * Three states, and the third is SUP-615's: nothing filed for the digest the
   * verdict names (ask), something filed and recently looked at (do not), or
   * something filed whose last retrieval is older than
   * `externalEndpoints.evidenceRefreshAfter` (ask again, because the upstream has
   * republished since and the copy this router relays has aged).
   *
   * "Last looked at" is `fetchedAt` rather than `issuedAt` on purpose. `issuedAt`
   * is the upstream's clock, so keying the re-poll on it would turn an upstream
   * whose *publisher* is wedged — reachable, serving, republishing nothing — into
   * a fetch every minute for ever. `fetchedAt` is this router's own clock, moved
   * by {@link record} on every retrieval including an idempotent one, so the cost
   * is one fetch per endpoint per refresh window whatever the upstream does. That
   * it lives in the row rather than only in {@link asked} is what keeps replicas
   * from each paying for it, and what makes a restarted pod inherit the schedule
   * instead of re-fetching everything at boot.
   */
  private async due(externalEndpointId: string, digest: string, now: Date): Promise<boolean> {
    const refreshAfter = this.config.externalEndpoints.evidenceRefreshAfter;
    const asked = this.asked.get(externalEndpointId);
    if (asked?.digest === digest && now.getTime() - asked.at < refreshAfter) {
      // This process asked recently. Answered without a query, which is the
      // point of the map: the common pass over a settled catalogue costs nothing.
      return false;
    }
    const filed = await this.filed(externalEndpointId, digest);
    return filed === null || now.getTime() - filed.fetchedAt.getTime() >= refreshAfter;
  }

  /**
   * Declares — once — that the copy this router hands out has aged past
   * `externalEndpoints.evidenceStaleAfter`, and says so where somebody will read
   * it (SUP-615). Returns whether it is stale, declared on this pass or earlier.
   *
   * This is the half the router was missing, and the shape of the miss is worth
   * recording: the relay went on answering 200 with a correctly signed bundle for
   * 37 hours, so nothing was failing anywhere — no verdict was denied, no
   * endpoint was dark, `/health` was green, and the first reader to notice was a
   * browser refusing to accept the document, as it should. A relayed publication
   * that is merely *old* is the one fault in this path that looks exactly like
   * health from the inside.
   *
   * Keyed on what the relay would actually serve
   * ({@link latestAdmitted}) rather than on the newest row for the endpoint,
   * because that is the document whose age locks the console. An endpoint with
   * nothing to relay is not reported here at all: a missing publication is the
   * typed 503 the controller already returns and the poll's own warning, and
   * declaring that one stale too would page an operator at the moment they
   * approve a new deployment.
   *
   * Four readers, as SUP-535 settled: the `ERROR` line a log sink can match, the
   * count this pass returns, the operator's inbox, and — through the inbox — the
   * person who would otherwise hear it from a user. The alert is awaited and
   * cannot fail the pass: `raise` never rejects.
   */
  private async reportStaleRelay(endpoint: ExternalEndpoint, now: Date): Promise<boolean> {
    const staleAfter = this.config.externalEndpoints.evidenceStaleAfter;
    if (staleAfter <= 0) {
      return false;
    }
    const relayed = await this.latestAdmitted(endpoint);
    if (!relayed) {
      // Nothing is being relayed, so there is no stale relay to report — and no
      // recovery either: the "it is back" line must not go out because an admin
      // withdrew the approval.
      this.declaredStale.delete(endpoint.id);
      return false;
    }

    const issuedAt = relayed.issuedAt.getTime();
    const stale = now.getTime() - issuedAt >= staleAfter;
    const declared = this.declaredStale.get(endpoint.id);
    if (stale && declared !== issuedAt) {
      this.declaredStale.set(endpoint.id, issuedAt);
      this.logger.error(staleRelayLine(endpoint, relayed.issuedAt, now));
      await this.alerts.raise(staleRelayAlert(endpoint, relayed.issuedAt, now), now);
      return true;
    }
    if (!stale && declared !== undefined) {
      this.declaredStale.delete(endpoint.id);
      this.logger.log(
        `The evidence this router relays for external endpoint "${endpoint.name}" is current again ` +
          `(signed ${durationSince(relayed.issuedAt, now)} ago).`,
      );
      // Past the interval, like a recovery from an outage: an operator who was
      // woken is owed the line that closes it.
      await this.alerts.raise(freshRelayAlert(endpoint, relayed.issuedAt, now), now, { urgent: true });
    }
    return stale;
  }

  /**
   * Fetches one upstream's bundle and files it, or throws.
   *
   * The binding check is the whole of this method's judgement, and it is
   * deliberately the weakest one that is still sound: *is the leaf this document
   * claims the leaf the sidecar observed on a verified report?* If it is, the
   * document came from the channel the verdict was about. If it is not, it is filed nowhere and rendered
   * nowhere, whatever else is true of it.
   */
  async refresh(endpoint: ExternalEndpoint, now: Date = new Date()): Promise<EvidenceSnapshot> {
    // The upstream's own authority, port included: `baseUrl` is canonical
    // `https://host[:port]` and an upstream published on 8443 serves its bundle
    // there too — defaulting to 443 would make a non-default port an endpoint
    // this router could never summarise. The bundle still has to *name*
    // `hostname`, which is what keeps the override from filing one upstream's
    // evidence under another.
    const raw = await fetchEvidenceBundle(
      { hostname: endpoint.hostname, evidenceUrl: `${endpoint.baseUrl}${EVIDENCE_PATH}` },
      { timeoutMs: FETCH_TIMEOUT_MS },
    );
    const parsed = parseEvidenceBundle(raw, endpoint.hostname);
    if (parsed.certFingerprint !== endpoint.observedCertFingerprint) {
      throw new Error(
        `the bundle claims the TLS leaf ${parsed.certFingerprint} and the sidecar observed ` +
          `${endpoint.observedCertFingerprint}, so it is not a document about the channel this verdict covers`,
      );
    }
    return this.record(endpoint.id, parsed, now);
  }

  /**
   * The external endpoint a relay path names, or null.
   *
   * Name first and hostname second, the own-endpoint relay's order
   * (`EvidenceService.endpointByNameOrHostname`), so `/v1/evidence/{endpoint}`
   * takes the same two spellings whichever table answers it. The two namespaces
   * are separate by design (`external_endpoints.name`), and the controller tries
   * ours first — a hostname this deployment publishes evidence for is never
   * also an upstream it verifies.
   */
  async endpointByNameOrHostname(value: string): Promise<ExternalEndpoint | null> {
    const repository = this.dataSource.getRepository(ExternalEndpoint);
    return (await repository.findOne({ where: { name: value } })) ?? repository.findOne({ where: { hostname: value } });
  }

  /**
   * The upstream publication this endpoint's last verdict named, or null.
   *
   * Keyed on `evidenceDigestSeen` rather than "the newest row for this endpoint",
   * and that is the whole of this method's judgement. The rule {@link refresh}
   * files bundles under is *the leaf the sidecar pinned*; the rule for handing one
   * out is *the digest a verdict actually saw*. Together they are what makes the
   * relayed document a document about the channel the router verified — a bundle
   * served by anyone but that upstream was never filed, and a real but superseded
   * publication of that upstream is never surfaced.
   *
   * Null is therefore the honest answer in four different situations, and the
   * caller reports all of them the same way (503, not a denial): no verdict yet, a
   * verdict whose publication this router has not managed to retrieve, an
   * upstream that republished between the verdict and the fetch — and, since
   * SUP-252, a deployment no admin has approved. Bundles are now filed *before*
   * approval, so the console can show what a digest stands for; the public relay
   * still hands out only the approved deployment's publication, which is the one
   * a user's own verification of "what this router lets my prompt reach" is about.
   */
  async latestAdmitted(endpoint: ExternalEndpoint): Promise<EvidenceSnapshot | null> {
    if (!endpoint.evidenceDigestSeen || endpoint.evidenceDigestSeen !== endpoint.pinnedEvidenceDigest) {
      return null;
    }
    return this.dataSource.getRepository(EvidenceSnapshot).findOne({
      where: { externalEndpointId: endpoint.id, evidenceDigest: endpoint.evidenceDigestSeen },
      // The most recently issued publication carrying that digest: a re-issue is
      // the same facts under a newer signature, and the fresher one is what a
      // reader comparing quote ages with the upstream's own host should get.
      order: { issuedAt: 'DESC', fetchedAt: 'DESC' },
    });
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

  /**
   * The most recently retrieved copy of one (endpoint, digest), or null.
   *
   * `fetchedAt DESC` rather than `issuedAt DESC`: the question this answers is
   * "when did this router last manage to get this publication", which is what
   * {@link due} schedules on. What to *hand out* is {@link latestAdmitted}'s
   * question, and it orders the other way for its own reason.
   */
  private async filed(externalEndpointId: string, evidenceDigest: string): Promise<EvidenceSnapshot | null> {
    return this.dataSource.getRepository(EvidenceSnapshot).findOne({
      where: { externalEndpointId, evidenceDigest },
      select: { id: true, fetchedAt: true },
      order: { fetchedAt: 'DESC' },
    });
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

/**
 * The stale relay as the `ERROR` line a log sink can match on.
 *
 * It names the consequence rather than the measurement, because the measurement
 * is fine: the bundle is genuine, its signature holds, and the only thing wrong
 * with it is its age — which is exactly why this took 37 hours to notice.
 */
function staleRelayLine(endpoint: ExternalEndpoint, issuedAt: Date, now: Date): string {
  return (
    `The evidence this router relays for external endpoint "${endpoint.name}" was signed ` +
    `${durationSince(issuedAt, now)} ago (${issuedAt.toISOString()}) and is no longer advancing. ` +
    'Past 24 hours every verifier refuses it, so the console’s upstream-evidence panel reports that the ' +
    'endpoint’s evidence did not check out and anyone verifying it through GET /v1/evidence answers the same — ' +
    'while the upstream itself may be publishing a fresh bundle every minute.'
  );
}

/**
 * The same fact, as the message that leaves the deployment (SUP-535).
 *
 * The endpoint's operator label and two timestamps, and nothing else: the
 * upstream hostname and the pinned digest stay behind a session (SUP-221 ruling
 * 3), as they do in `outageAlert`, because mail gets forwarded.
 */
function staleRelayAlert(
  endpoint: ExternalEndpoint,
  issuedAt: Date,
  now: Date,
): { title: string; summary: string; facts: Array<[string, string]>; action: string } {
  return {
    title: `Evidence relayed for “${endpoint.name}” has stopped advancing`,
    summary:
      `This router is still handing out a copy of “${endpoint.name}”’s evidence that was signed ` +
      `${durationSince(issuedAt, now)} ago. The upstream is serving — its models still route — but the ` +
      'relayed document is ageing, and once it passes 24 hours every verifier refuses it: the console reports ' +
      'that this endpoint’s evidence did not check out, and so does anyone who verifies it through this ' +
      'router. It is the copy that is old, not necessarily the upstream.',
    facts: [
      ['Endpoint', endpoint.name],
      ['Relayed copy signed', issuedAt.toISOString()],
      ['Age', durationSince(issuedAt, now)],
    ],
    action:
      'Nothing needs approving: the digest has not changed. Check that this deployment can still reach the ' +
      'upstream’s /.well-known/swarm-evidence — a refresh that has been failing is in this router’s log as ' +
      '“No evidence summary for external endpoint”.',
  };
}

/** Its counterpart, sent once when a refresh lands and the copy is current again. */
function freshRelayAlert(
  endpoint: ExternalEndpoint,
  issuedAt: Date,
  now: Date,
): { title: string; summary: string; facts: Array<[string, string]>; action: string } {
  return {
    title: `Evidence relayed for “${endpoint.name}” is current again`,
    summary: `This router has refreshed its copy of “${endpoint.name}”’s evidence; verifiers will accept it again.`,
    facts: [
      ['Endpoint', endpoint.name],
      ['Relayed copy signed', issuedAt.toISOString()],
      ['Age', durationSince(issuedAt, now)],
    ],
    action: 'No action needed.',
  };
}
