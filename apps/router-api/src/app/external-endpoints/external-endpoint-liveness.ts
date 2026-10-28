import type { ExternalEndpoint, ExternalEndpointStatus } from '../db/entities/external-endpoint.entity.js';

/**
 * Reading a registered upstream's failure run: is it reachable, has it been dark
 * long enough to wake somebody, and what does the one unauthenticated call say
 * about it (SUP-517).
 *
 * Pure, and separate from the service that writes the rows, for the reason
 * `status-projection.ts` is: the interesting part is the rule, not the SQL. The
 * rule has one shape and three readers — the log line that pages, the
 * `external_endpoint_events` timeline, and `GET /health` — and all three have to
 * agree, because an operator who catches them disagreeing stops trusting
 * whichever one was cheapest to check.
 */

/**
 * Whether the upstream answered at all, as distinct from whether this router
 * admitted what it answered with.
 *
 * The distinction is the whole lesson of the outage this exists for. A gateway
 * lost the route for a published hostname, the TLS handshake was reset, the
 * sidecar's bundle fetch failed with `fetch: EOF` — and the denial that followed
 * read, from every surface, exactly like a digest an admin had not got round to
 * approving. The two call for opposite actions: "the upstream is down, go fix the
 * cloud" and "open the console and approve a deployment".
 *
 * - `unreachable` — the dial, the handshake or the read failed, so nothing
 *   arrived and nothing was judged. Nothing is being asserted about the
 *   upstream's trustworthiness; it did not speak.
 * - `reachable` — it answered. Either the verdict admitted, or verification or
 *   policy refused what it answered with, which is a judgement about a live
 *   upstream.
 * - `unknown` — nothing has been checked since this process started. Honest, and
 *   the state every row boots in (ADR-008 §8).
 *
 * **Read from the sidecar, not inferred here.** `Report.Unreachable` (SUP-422)
 * is the authoritative answer and is narrower than the `fetch` stage: an
 * over-sized bundle, a hostname the gatekeeper refuses, and a non-2xx answer to
 * the bundle fetch all stop at `fetch` with the flag unset, because the upstream
 * answered — badly. An ingress that serves completions while
 * `/.well-known/swarm-evidence` 404s is a plausible presentation of the very
 * gateway misconfiguration behind SUP-491, and reporting it as "the upstream did
 * not answer" would send an operator to look at a cloud that is fine.
 */
export type EndpointReachability = 'reachable' | 'unreachable' | 'unknown';

/**
 * The fallback, for a row whose `upstreamUnreachable` was never recorded.
 *
 * Wider than the flag and deliberately only a fallback: a verdict projected
 * before that column existed has the stage and nothing else, and `fetch` is the
 * best available guess there. Every later stage — `cert-chain`,
 * `untrusted-root`, `jws`, `tls-fingerprint`, `policy` — and every two-factor
 * refusal is reached only by having something to inspect, so each of them is
 * itself evidence that the upstream is up. The boot reset retires the question
 * within one poll of a restart.
 */
const UNREACHABLE_STAGE_FALLBACK = 'fetch';

/** The columns this module reads. A subset, so a test can build one by hand. */
export type LivenessRow = Pick<
  ExternalEndpoint,
  | 'name'
  | 'enabled'
  | 'status'
  | 'lastStage'
  | 'lastReason'
  | 'lastCheckedAt'
  | 'upstreamUnreachable'
  | 'lastSuccessAt'
  | 'notServingSince'
  | 'consecutiveFailures'
  | 'pinnedEvidenceDigest'
>;

export function reachabilityOf(
  row: Pick<LivenessRow, 'status' | 'lastStage' | 'lastCheckedAt' | 'upstreamUnreachable'>,
): EndpointReachability {
  if (!row.lastCheckedAt) {
    return 'unknown';
  }
  if (row.status === 'verified') {
    return 'reachable';
  }
  const reported = row.upstreamUnreachable ?? null;
  if (reported !== null) {
    return reported ? 'unreachable' : 'reachable';
  }
  return row.lastStage === UNREACHABLE_STAGE_FALLBACK ? 'unreachable' : 'reachable';
}

/**
 * When a run of failed checks becomes an outage.
 *
 * Two thresholds, because they miss different things. A count is the honest unit
 * while an endpoint is being checked on schedule; it says nothing at all when the
 * checking itself has stopped — a sidecar that never answers leaves every row at
 * `pending` and increments no counter — and then only elapsed time notices. `0`
 * disables either one.
 */
export interface OutageThresholds {
  /** Distinct failed checks in a row. */
  afterFailures: number;
  /** Milliseconds since the endpoint was last known to serve. */
  afterNoSuccess: number;
}

/**
 * Whether this router should expect the endpoint to be serving right now.
 *
 * Enabled, and with a deployment an admin has approved. Both halves keep the
 * alert honest rather than merely quiet:
 *
 * - `enabled: false` is a row an operator took out of service. Nothing is
 *   expected of it, and paging for it would teach the operator to ignore pages.
 * - `pinnedEvidenceDigest: null` means no deployment has ever been approved, so
 *   the endpoint is `pending` with `digest-not-pinned` *by design* (SUP-252) and
 *   will stay there until an admin acts. That is a registration half-finished,
 *   not an upstream that went dark, and the two must not share an alarm — an
 *   upgrade that made every existing endpoint need one approval would otherwise
 *   have paged for all of them at once.
 *
 * Note what this does *not* exempt: an endpoint whose pin no longer matches
 * (`digest-mismatch` after an unapproved redeploy). A pin exists, so this router
 * was serving that upstream a moment ago and is not now — which is exactly an
 * outage, whoever caused it.
 */
export function expectedToServe(row: LivenessRow): boolean {
  return row.enabled && row.pinnedEvidenceDigest !== null;
}

/**
 * Whether this row has been dark past either threshold.
 *
 * `pending` counts, not only `denied`: a caller cannot tell the difference, and
 * the sidecar-never-answered case produces nothing else to notice. What keeps
 * that from being noisy is {@link expectedToServe}, not a narrower reading of
 * {@link LivenessRow.notServingSince}.
 */
export function isOutage(row: LivenessRow, thresholds: OutageThresholds, now: Date): boolean {
  const since = row.notServingSince ?? null;
  if (!expectedToServe(row) || since === null) {
    return false;
  }
  if (thresholds.afterFailures > 0 && (row.consecutiveFailures ?? 0) >= thresholds.afterFailures) {
    return true;
  }
  return thresholds.afterNoSuccess > 0 && now.getTime() - since.getTime() >= thresholds.afterNoSuccess;
}

/** One upstream's answer to "is it serving", as the alert and the timeline read it. */
export interface EndpointLiveness {
  name: string;
  status: ExternalEndpointStatus;
  reachability: EndpointReachability;
  /** The stage or trust factor the last check stopped at; null when it admitted. */
  stage: string | null;
  /** The sidecar's own one-line explanation of the refusal; null when it admitted. */
  reason: string | null;
  consecutiveFailures: number;
  notServingSince: Date | null;
  lastSuccessAt: Date | null;
  lastCheckedAt: Date | null;
  /** Whether this run has passed a threshold — the thing worth waking somebody for. */
  outage: boolean;
}

export function livenessOf(row: LivenessRow, thresholds: OutageThresholds, now: Date): EndpointLiveness {
  return {
    name: row.name,
    status: row.status,
    reachability: reachabilityOf(row),
    stage: row.status === 'verified' ? null : row.lastStage,
    reason: row.status === 'verified' ? null : row.lastReason,
    consecutiveFailures: row.consecutiveFailures ?? 0,
    notServingSince: row.notServingSince ?? null,
    lastSuccessAt: row.lastSuccessAt ?? null,
    lastCheckedAt: row.lastCheckedAt,
    outage: isOutage(row, thresholds, now),
  };
}

/**
 * What `GET /health` says about registered external upstreams.
 *
 * Counts and two timestamps, and **no endpoint names, hostnames, stages or
 * reasons**: `/health` is public and unauthenticated, and ruling 3 on SUP-221
 * keeps upstream identity and verdict detail out of what an anonymous caller
 * sees. The per-endpoint answer lives behind a session, on `ExternalEndpoint` in
 * the console schema, where the rest of the verdict already is.
 *
 * What is published here adds nothing an anonymous caller cannot already derive:
 * the public `models` query reports `available` per model, so "a registered
 * external model is not currently routable" is on the wire today. The counts
 * aggregate it; `status` and `since` are what turn a fact into an alarm.
 */
export interface ExternalEndpointsStatus {
  /**
   * - `none` — nothing registered, so there is nothing to be wrong.
   * - `unknown` — registered endpoints exist and no status pass has completed, so
   *   this router cannot say. A boot, polling switched off, or a sidecar that has
   *   never answered.
   * - `ok` — every enabled upstream holds an admitting verdict.
   * - `degraded` — at least one does not, and no run has passed a threshold yet.
   * - `outage` — at least one run has. This is the value to alert on.
   */
  status: 'none' | 'unknown' | 'ok' | 'degraded' | 'outage';
  /** Enabled upstreams. A disabled one is out of service and counted nowhere. */
  registered: number;
  /** Holding an admitting verdict right now — what the catalogue will route to. */
  serving: number;
  /** Denied by the last check: this router looked and refused. */
  failing: number;
  /** Of {@link failing}, those whose last check never got a document back. */
  unreachable: number;
  /** Checked, not admitted, not denied: awaiting a first check or an admin's approval. */
  pending: number;
  /** When the longest-running outstanding "not serving" began. Absent when all are serving. */
  since?: string;
  /**
   * When the sidecar's verdicts were last read back. Absent until the first pass.
   *
   * Here because every count above is a projection of that read: a timestamp that
   * has stopped moving says the numbers are stale, which is the one failure the
   * counts cannot show by themselves.
   */
  verdictsReadAt?: string;
}

export function summarise(
  livenesses: readonly EndpointLiveness[],
  verdictsReadAt: Date | null,
): ExternalEndpointsStatus {
  const failing = livenesses.filter((liveness) => liveness.status === 'denied');
  const since = livenesses
    .filter((liveness) => liveness.status !== 'verified')
    .map((liveness) => liveness.notServingSince)
    .filter((value): value is Date => value !== null)
    .reduce<Date | null>((oldest, value) => (oldest === null || value < oldest ? value : oldest), null);

  return {
    status: statusOfSummary(livenesses, verdictsReadAt),
    registered: livenesses.length,
    serving: livenesses.filter((liveness) => liveness.status === 'verified').length,
    failing: failing.length,
    unreachable: failing.filter((liveness) => liveness.reachability === 'unreachable').length,
    pending: livenesses.filter((liveness) => liveness.status === 'pending').length,
    ...(since ? { since: since.toISOString() } : {}),
    ...(verdictsReadAt ? { verdictsReadAt: verdictsReadAt.toISOString() } : {}),
  };
}

function statusOfSummary(
  livenesses: readonly EndpointLiveness[],
  verdictsReadAt: Date | null,
): ExternalEndpointsStatus['status'] {
  if (livenesses.length === 0) {
    return 'none';
  }
  if (livenesses.some((liveness) => liveness.outage)) {
    return 'outage';
  }
  // Checked after `outage` on purpose: a threshold crossed on elapsed time is a
  // real answer even when no verdict has ever been read back, and that is
  // precisely the sidecar-never-answered case.
  if (verdictsReadAt === null) {
    return 'unknown';
  }
  return livenesses.every((liveness) => liveness.status === 'verified') ? 'ok' : 'degraded';
}

/**
 * The one line an operator is woken by.
 *
 * Everything needed to act, and nothing that needs a console to resolve: which
 * upstream, how long, how many checks, whether it answered at all, and the
 * sidecar's own words. Written as `logger.error` precisely once per run by
 * `ExternalEndpointStatusService`, because a line repeated every five seconds is
 * a line a log alert is configured to ignore.
 */
export function outageLine(liveness: EndpointLiveness, now: Date): string {
  const parts = [
    `${liveness.consecutiveFailures} consecutive failed check(s)`,
    liveness.reachability === 'unreachable' ? 'the upstream did not answer' : `reachability ${liveness.reachability}`,
  ];
  if (liveness.stage) {
    parts.push(`stage ${liveness.stage}`);
  }
  if (liveness.reason) {
    parts.push(`reason "${liveness.reason}"`);
  }
  return (
    `External endpoint "${liveness.name}" has not served for ${durationSince(liveness.notServingSince, now)}: ` +
    `${parts.join(', ')}. Every model on it is refused with 503 attestation_failed.`
  );
}

/** Its counterpart, logged once when an admitting verdict closes the run. */
export function recoveryLine(liveness: EndpointLiveness, declaredAt: Date, now: Date): string {
  return (
    `External endpoint "${liveness.name}" is serving again after ${durationSince(declaredAt, now)}; ` +
    'its models are routable.'
  );
}

/**
 * The same outage, as the message that leaves the deployment (SUP-535).
 *
 * Built from {@link EndpointLiveness} beside {@link outageLine} rather than from
 * the log line, so the mail and the log cannot disagree about how long an upstream
 * has been down — the disagreement that teaches an operator to stop trusting
 * whichever was cheaper to check.
 *
 * The endpoint's name is the only identifier: it is the operator's own label.
 * The upstream hostname, the pinned digest and the sidecar's verdict detail stay
 * in the console, behind a session (SUP-221 ruling 3) — mail gets forwarded.
 *
 * **{@link EndpointLiveness.reason} is deliberately not here**, which is the one
 * place this was got wrong first. It is the sidecar's own sentence, up to 255
 * characters of free text, and it routinely embeds exactly what the paragraph
 * above says stays behind a session: `external-endpoints.e2e.spec.ts` asserts a
 * denial's reason *contains the measurement hex*, and a `fetch` refusal names the
 * URL it could not read. The stage is the same information in a bounded form —
 * `policy`, `fetch`, `untrusted-root` — and it is what an operator needs to know
 * which way to go. The sentence itself is in the log line and in the endpoint's
 * timeline, both of which require being inside the deployment or holding a
 * session.
 */
export function outageAlert(
  liveness: EndpointLiveness,
  now: Date,
): { title: string; summary: string; facts: Array<[string, string]>; action: string } {
  const facts: Array<[string, string]> = [
    ['Endpoint', liveness.name],
    ['Not serving for', durationSince(liveness.notServingSince, now)],
    ['Failed checks in a row', String(liveness.consecutiveFailures)],
    [
      'Upstream',
      liveness.reachability === 'unreachable'
        ? 'did not answer at all'
        : liveness.reachability === 'reachable'
          ? 'answered, and this router refused what it answered with'
          : 'not checked since this process started',
    ],
  ];
  if (liveness.stage) {
    facts.push(['Stopped at stage', liveness.stage]);
  }
  return {
    title: `External endpoint “${liveness.name}” has stopped serving`,
    summary:
      `Every model on “${liveness.name}” is being refused with 503 attestation_failed, and has been for ` +
      `${durationSince(liveness.notServingSince, now)}.`,
    facts,
    action:
      liveness.reachability === 'unreachable'
        ? 'The upstream did not answer, so this is the upstream’s cloud rather than an approval: check that the ' +
          'model deployment is up and that its hostname still routes. Nothing here needs approving.'
        : 'The upstream answered and this router refused what it answered with. If it was redeployed on purpose, ' +
          'approve the new deployment’s evidence digest in the console; if it was not, that refusal is the point. ' +
          'The sidecar’s own wording for the refusal is on the endpoint’s timeline in the console.',
  };
}

/** The recovery, as the message that closes the alert. */
export function recoveryAlert(
  liveness: EndpointLiveness,
  declaredAt: Date,
  now: Date,
): { title: string; summary: string; facts: Array<[string, string]>; action: string } {
  return {
    title: `External endpoint “${liveness.name}” is serving again`,
    summary: `“${liveness.name}” holds an admitting verdict again; its models are routable.`,
    facts: [
      ['Endpoint', liveness.name],
      ['Was not serving for', durationSince(declaredAt, now)],
    ],
    action: 'No action needed. The endpoint’s timeline in the console holds the run that just closed.',
  };
}

/** `reason` for an `outage` / `recovered` timeline row. Clipped by the caller, like any other. */
export function outageReason(liveness: EndpointLiveness, now: Date): string {
  const since = durationSince(liveness.notServingSince, now);
  return `Not serving for ${since} after ${liveness.consecutiveFailures} failed check(s); ${liveness.reachability}.`;
}

/**
 * A coarse human duration — minutes up to an hour, then hours, then days.
 *
 * Coarse on purpose: these strings go into a log line and a timeline row that a
 * human reads, and "31h" is the number that makes the point the outage made. The
 * exact instant is on the row beside it.
 */
export function durationSince(from: Date | null, now: Date): string {
  if (!from) {
    return 'an unknown period';
  }
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${Math.floor(hours / 24)}d`;
}
