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
  | 'apiKeyCiphertext'
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
   * - `degraded` — at least one does not, and no run has passed a threshold yet;
   *   or this deployment is dark and has not been for long enough to wake
   *   somebody ({@link CatalogueDarkness}).
   * - `outage` — at least one run has, **or** `routable` has been behind
   *   `serving` for two consecutive passes: the rows admit an upstream and
   *   admission refuses it (SUP-600), **or** this deployment has advertised
   *   models it can route to none of for longer than `outage.afterNoSuccess`
   *   (SUP-879). This is the value to alert on.
   *
   * `none` is now what it says and nothing more: no external model is registered
   * here, so there is nothing for an upstream to serve. A deployment holding
   * models with every upstream switched off used to land on it, which is how a
   * rebuilt production read `status: none` — inside a document reading `ok` —
   * while `/v1/models` answered `[]`.
   */
  status: 'none' | 'unknown' | 'ok' | 'degraded' | 'outage';
  /** Enabled upstreams. A disabled one is out of service and counted nowhere. */
  registered: number;
  /**
   * Holding an admitting verdict right now, as of the last pass — the rows' own
   * answer, and **not** a promise about `/v1` (SUP-600).
   */
  serving: number;
  /**
   * How many enabled upstreams the *catalogue* will route to — admission's own
   * answer, counted independently of the rows'.
   *
   * Not a subset of {@link serving} but a second derivation of it, in the same
   * unit and from the same table: `serving` is what the stored verdicts say,
   * this is what `/v1` will do with them, and the two are meant to be equal.
   * `routable < serving` means a model whose row says it is admitted is being
   * refused with a 503 `attestation_failed`.
   *
   * **The two come from two reads, one pass apart at most.** `serving` is
   * derived from the rows the pass read at its start plus the verdicts it then
   * projected; `routable` from the rebuild at its end. A write that lands
   * between them — which is exactly what the pod booting beside this one does
   * during the surge window — makes them differ for that one pass and no
   * longer. So a single disagreeing pass is not a fault, and
   * {@link ExternalEndpointsStatus.status} waits for a second one before it says
   * `outage`: one pass's two reads can straddle a commit, two consecutive
   * passes' four cannot straddle the same one. The fault this pair exists to
   * name did not come and go — it lasted for the life of the pod.
   *
   * Here because that pair happened and this document could not say so. A cold
   * pod start left the row saying `verified` and this router's catalogue empty;
   * `serving: 1` was the whole answer an operator got while production's `/v1`
   * was dark. The cause is fixed — the catalogue is re-derived from the rows on
   * every pass — and the comparison stays, because "what the row says" and "what
   * admission will do" are different facts and a health document that reports
   * one as if it were the other is how that outage stayed invisible. An
   * inequality also makes {@link ExternalEndpointsStatus.status} `outage`, so
   * nothing has to notice two numbers to notice the fault.
   */
  routable: number;
  /** Denied by the last check: this router looked and refused. */
  failing: number;
  /** Of {@link failing}, those whose last check never got a document back. */
  unreachable: number;
  /** Checked, not admitted, not denied: awaiting a first check or an admin's approval. */
  pending: number;
  /**
   * Registered endpoints an operator's switch is off on — the rows every count
   * above is blind to, because {@link registered} is the enabled ones (SUP-879).
   *
   * Here because the one state this document used to report as `none` is a
   * deployment whose every upstream is switched off: a rebuilt production holds
   * exactly that, since an import lands every endpoint off and unkeyed, and
   * `registered: 0` beside `status: none` reads as "nothing to be wrong" when
   * the truth is "nothing can serve".
   */
  disabled: number;
  /**
   * Of the registered endpoints, those holding no upstream API key at all.
   *
   * The step an operator still owes, counted: the export bundle carries no
   * secret of any kind, so every imported upstream arrives with an empty
   * envelope and cannot be proxied to until the key is entered again. A
   * registration somebody abandoned before entering a key lands here too, and
   * the fix is the same one.
   */
  awaitingKey: number;
  /**
   * Enabled external models registered here, routable or not — **including**
   * the ones whose endpoint is switched off, which no other count sees
   * (SUP-879).
   *
   * The denominator the rest of this document was missing. Zero routable
   * upstreams is nothing to report on a deployment that has no external models;
   * on one that has them it means `/v1/models` is advertising nothing and every
   * completion is refused.
   */
  models: number;
  /**
   * Of {@link models}, the ones `/v1/models` lists right now — the catalogue's
   * answer in models rather than in endpoints.
   *
   * `routable` is the same fact in the unit `serving` is counted in, so that the
   * rows and admission can be compared; this is the number a caller of the
   * product actually meets.
   */
  routableModels: number;
  /**
   * When the longest-running outstanding "not serving" began: a row's own run,
   * or — on a deployment with no enabled row at all — the moment this process
   * first found nothing routable (SUP-879). Absent when everything is serving.
   */
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

/**
 * The catalogue's side of the `/health` cross-check (SUP-600).
 *
 * Two facts that have to travel together, because one of them is only
 * meaningful as a repetition — see {@link ExternalEndpointsStatus.routable}.
 */
export interface CatalogueReach {
  /** How many enabled upstreams the catalogue will route to, as this pass left it. */
  routable: number;
  /** {@link ExternalEndpointsStatus.models}, as the same pass counted them. */
  models: number;
  /** {@link ExternalEndpointsStatus.routableModels}, from the same rebuild as `routable`. */
  routableModels: number;
  /** {@link ExternalEndpointsStatus.disabled}, from the rows this pass read. */
  disabled: number;
  /** {@link ExternalEndpointsStatus.awaitingKey}, from the same rows. */
  awaitingKey: number;
  /** Whether this deployment can serve anything at all, and for how long not. */
  darkness: CatalogueDarkness;
}

/** {@link CatalogueReach} plus the one fact only `/health`'s own state carries. */
export interface CatalogueView extends CatalogueReach {
  /** Whether the pass before this one was already short of `serving`. */
  behindBefore: boolean;
}

/**
 * Whether this deployment advertises external models it will route to none of —
 * the failure a rebuilt production wears while every surface reads healthy
 * (SUP-879).
 *
 * This is the hole the per-endpoint outage rule cannot cover, and it is a hole
 * by construction rather than by oversight. {@link expectedToServe} exempts a
 * switched-off row and an unapproved one on purpose, and an import lands every
 * upstream switched off with an empty key envelope because the bundle carries no
 * secrets — so a rebuilt deployment holds no row anything is expected of,
 * `alertOnOutages` has nobody to speak for, `/health` reports
 * `externalEndpoints: none` and `/v1/models` answers `[]`. Four minutes of that
 * passed unnoticed on production on 2026-11-22 with the deploy train reporting
 * success throughout.
 *
 * So the subject here is the deployment rather than an endpoint: models are
 * registered, and not one of them can be served. It is deliberately silent
 * wherever the per-endpoint rule can speak — an enabled, approved upstream that
 * went dark is that rule's run, and two messages for one outage is how an
 * operator learns to filter both.
 */
export interface CatalogueDarkness {
  /** Models are registered here and the catalogue will route to none of them. */
  dark: boolean;
  /** Since when this process has seen it dark; null while it is not. */
  since: Date | null;
  /**
   * Dark for longer than `outage.afterNoSuccess` — the state worth waking
   * somebody for.
   *
   * The delay is what keeps a boot quiet: every pod comes up with its rows held
   * at `pending` and its catalogue empty, so a deployment that is about to be
   * fine is dark for a poll or two, and alerting on that would teach an operator
   * to ignore the message that matters. Measured from when *this process* first
   * saw darkness, for the reason the per-run latch is in memory: the question is
   * what this router can serve now, and a restart is entitled to answer it from
   * scratch.
   */
  outage: boolean;
}

/** The clock {@link darknessOf} is given, since it keeps none of its own. */
export interface DarknessClock {
  thresholds: OutageThresholds;
  /** When this process first saw this run of darkness; null when the last pass saw none. */
  since: Date | null;
  now: Date;
}

/**
 * The darkness rule. Pure, like every other rule here, and given the clock
 * rather than keeping one.
 *
 * @param rows every registered endpoint, enabled or not — the switched-off ones
 *   are the whole point.
 */
export function darknessOf(
  rows: readonly LivenessRow[],
  reach: Pick<CatalogueReach, 'models' | 'routableModels'>,
  { thresholds, since, now }: DarknessClock,
): CatalogueDarkness {
  // Nothing registered, something routable, or an upstream the per-endpoint rule
  // is already watching: not this rule's business.
  if (reach.models === 0 || reach.routableModels > 0 || rows.some(expectedToServe)) {
    return { dark: false, since: null, outage: false };
  }
  const dark = since ?? now;
  const elapsed = now.getTime() - dark.getTime();
  return {
    dark: true,
    since: dark,
    // `0` disables it, as it disables the per-endpoint thresholds. The other
    // threshold, `afterFailures`, has nothing to count here: a deployment with no
    // enabled upstream performs no checks at all, which is precisely why elapsed
    // time is the only honest unit for this one.
    outage: thresholds.afterNoSuccess > 0 && elapsed >= thresholds.afterNoSuccess,
  };
}

export function summarise(
  livenesses: readonly EndpointLiveness[],
  verdictsReadAt: Date | null,
  catalogue: CatalogueView,
): ExternalEndpointsStatus {
  const failing = livenesses.filter((liveness) => liveness.status === 'denied');
  const since = [
    ...livenesses.filter((liveness) => liveness.status !== 'verified').map((liveness) => liveness.notServingSince),
    // The deployment's own run belongs here rather than nowhere: with every
    // endpoint switched off there is no row to carry it, and an `outage` with no
    // `since` beside it is the half-answer this document was reporting already.
    catalogue.darkness.since,
  ]
    .filter((value): value is Date => value !== null)
    .reduce<Date | null>((oldest, value) => (oldest === null || value < oldest ? value : oldest), null);

  const serving = livenesses.filter((liveness) => liveness.status === 'verified').length;
  const { routable, behindBefore, darkness } = catalogue;

  return {
    status: statusOfSummary(livenesses, verdictsReadAt, { unroutable: routable < serving && behindBefore, darkness }),
    registered: livenesses.length,
    serving,
    routable,
    failing: failing.length,
    unreachable: failing.filter((liveness) => liveness.reachability === 'unreachable').length,
    pending: livenesses.filter((liveness) => liveness.status === 'pending').length,
    disabled: catalogue.disabled,
    awaitingKey: catalogue.awaitingKey,
    models: catalogue.models,
    routableModels: catalogue.routableModels,
    ...(since ? { since: since.toISOString() } : {}),
    ...(verdictsReadAt ? { verdictsReadAt: verdictsReadAt.toISOString() } : {}),
  };
}

function statusOfSummary(
  livenesses: readonly EndpointLiveness[],
  verdictsReadAt: Date | null,
  {
    unroutable,
    darkness,
  }: {
    /** The catalogue has been short of the rows for two passes running. */
    unroutable: boolean;
    darkness: CatalogueDarkness;
  },
): ExternalEndpointsStatus['status'] {
  // Before the `none` below, and for the same reason it is one word rather than
  // a third enum value: a deployment that advertises models and serves none of
  // them is an outage to everybody who meets it, whatever the rows say about
  // whose fault it is, and a probe that watches this field has to catch it
  // (SUP-879).
  if (darkness.outage) {
    return 'outage';
  }
  if (livenesses.length === 0) {
    // `none` only when there is genuinely nothing to serve. Dark with no enabled
    // row is `degraded` until the threshold above: true, and quiet, through the
    // poll or two a booting pod spends there.
    return darkness.dark ? 'degraded' : 'none';
  }
  // Two causes, one word. A run that crossed a threshold is the upstream's
  // outage; a catalogue two passes short of the rows is this router's own — the
  // rows admit and admission refuses, which is the same thing to a caller and
  // was reported as `ok` until SUP-600. Saying `outage` is what lets a probe
  // that watches one field catch it; the two counts beside it say which of the
  // two it is.
  if (unroutable || livenesses.some((liveness) => liveness.outage)) {
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

/**
 * The deployment-level line, logged once a run of darkness crosses the
 * threshold (SUP-879).
 *
 * Counts, a duration and what to do — the same contract as {@link outageLine},
 * with no endpoint to name because the subject is the deployment.
 */
export function darkCatalogueLine(darkness: CatalogueDarkness, reach: CatalogueReach, now: Date): string {
  return (
    `This deployment has advertised ${reach.models} external model(s) and routed to none of them for ` +
    `${durationSince(darkness.since, now)}: ${reach.disabled} registered endpoint(s) are switched off, ` +
    `${reach.awaitingKey} hold no upstream API key. GET /v1/models answers [] and every completion on them is ` +
    'refused.'
  );
}

/** Its counterpart, logged once the catalogue routes to something again. */
export function litCatalogueLine(declaredAt: Date, reach: CatalogueReach, now: Date): string {
  return (
    `This deployment is advertising ${reach.routableModels} routable external model(s) again after ` +
    `${durationSince(declaredAt, now)} with none.`
  );
}

/**
 * The same darkness, as the message that leaves the deployment.
 *
 * Written for the one person who will read it: an operator who has just rebuilt
 * production, checked the hostnames, the evidence, the sign-in and the imported
 * data, found all of them good — and is therefore the least likely person in the
 * world to notice a zero. So the action is the two mutations that end it, named,
 * rather than an invitation to go and look at a dashboard.
 *
 * Counts only, no endpoint names or hostnames: mail gets forwarded, and the
 * message does not need them. `awaitingKey` is what tells the two causes apart,
 * and it is the one an import leaves.
 */
export function darkCatalogueAlert(
  darkness: CatalogueDarkness,
  reach: CatalogueReach,
  now: Date,
): { title: string; summary: string; facts: Array<[string, string]>; action: string } {
  return {
    title: 'This deployment is serving no models at all',
    summary:
      `${reach.models} external model(s) are registered here and none of them is routable, for ` +
      `${durationSince(darkness.since, now)} now. GET /v1/models answers an empty list and every completion is ` +
      'refused.',
    facts: [
      ['Registered external models', String(reach.models)],
      ['Routable right now', String(reach.routableModels)],
      ['Endpoints switched off', String(reach.disabled)],
      ['Endpoints with no upstream API key', String(reach.awaitingKey)],
      ['Serving nothing for', durationSince(darkness.since, now)],
    ],
    action:
      reach.awaitingKey > 0
        ? 'This is the shape a rebuilt deployment has until its upstream keys are entered again: a data import ' +
          'lands every external endpoint switched off and without a key, because the export bundle carries no ' +
          'secrets. Under Administration → External endpoints, rotate each endpoint’s upstream API key and ' +
          'enable it; it attests and starts serving within about a minute.'
        : 'No registered upstream is both enabled and approved. Under Administration → External endpoints, ' +
          'enable the endpoint you expect to serve and approve its evidence digest; an endpoint that has never ' +
          'had a digest approved stays pending by design and is not an upstream failure.',
  };
}

/** The recovery, as the message that closes the deployment-level alert. */
export function litCatalogueAlert(
  declaredAt: Date,
  reach: CatalogueReach,
  now: Date,
): { title: string; summary: string; facts: Array<[string, string]>; action: string } {
  return {
    title: 'This deployment is serving models again',
    summary:
      `${reach.routableModels} external model(s) are routable again after ${durationSince(declaredAt, now)} ` +
      'with none.',
    facts: [
      ['Routable external models', String(reach.routableModels)],
      ['Served nothing for', durationSince(declaredAt, now)],
    ],
    action: 'No action needed. GET /v1/models lists them again.',
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
