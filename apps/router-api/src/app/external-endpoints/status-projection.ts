import type { ExternalEndpoint, ExternalEndpointStatus } from '../db/entities/external-endpoint.entity.js';
import type { ExternalEndpointEventKind } from '../db/entities/external-endpoint-event.entity.js';
import type { SidecarReport, SidecarVerdict } from './sidecar-admin.client.js';

/**
 * Turning one sidecar verdict into one row update and the events it caused
 * (ADR-008 §6, §8).
 *
 * Pure, and separated from the service that writes it, because the interesting
 * part is not the SQL — it is which changes are worth an event. The rule: a
 * *transition* is an event, a repetition is not. A verified endpoint re-attesting
 * every ten minutes would otherwise write 144 rows a day saying nothing, and the
 * timeline an operator reads for "when did this cloud change what it runs" would
 * be unreadable.
 *
 * Three transitions are tracked separately from the status itself: the
 * deployment digest changing, the measurement changing, and the status flipping.
 * Under two-factor trust (SUP-252) a digest change is gating — the pin no longer
 * matches, so it arrives together with the `denied` it caused, and the timeline
 * shows both.
 *
 * Beside the verdict itself the projection also keeps the *run* it belongs to —
 * last success, last failure, since when, how many in a row (SUP-517, see
 * {@link runOf}). Same reasoning one level up: a single failed check is a
 * repetition, a run of them is the event, and nothing could tell them apart from
 * a row that only ever held the latest verdict.
 */

/** The columns a verdict may write. `enabled` and the key columns are never among them. */
export type ExternalEndpointStatusPatch = Pick<
  ExternalEndpoint,
  | 'status'
  | 'lastCheckedAt'
  | 'lastStage'
  | 'lastReason'
  | 'measurementSeen'
  | 'measurementSource'
  | 'measurementInRegistry'
  | 'evidenceDigestSeen'
  | 'pinnedCertFingerprint'
  | 'observedCertFingerprint'
  | 'lastSuccessAt'
  | 'lastFailureAt'
  | 'notServingSince'
  | 'consecutiveFailures'
  | 'upstreamUnreachable'
>;

/** One row to append to the timeline. */
export interface ProjectedEvent {
  kind: ExternalEndpointEventKind;
  stage: string | null;
  reason: string | null;
  measurement: string | null;
  evidenceDigest: string | null;
}

export interface ProjectedVerdict {
  patch: ExternalEndpointStatusPatch;
  events: ProjectedEvent[];
  /** Whether the admission decision changed, and the catalogue therefore has to be rebuilt. */
  statusChanged: boolean;
  /**
   * Whether any projected column differs from the row — i.e. whether the write is
   * worth doing at all.
   *
   * The poll runs every five seconds and a re-attestation every ten minutes, so
   * most passes see the verdict they saw last time, down to `checkedAt`. Without
   * this the service would issue an `UPDATE` per endpoint per poll and keep
   * `updatedAt` moving on rows that had not changed, which is both pointless
   * write load and a column that stops meaning anything.
   */
  patchChanged: boolean;
}

/**
 * The verdict's own view of whether traffic may flow.
 *
 * `admitted` is the only field that answers it: `verified` covers the
 * cryptography (stages 1–6) while `admitted` additionally requires every policy
 * package to allow — and the measurement-against-the-admin-list check is a policy
 * clause (ADR-008 §3). So a report that is `verified` but not `admitted` is an
 * upstream whose evidence is sound and whose cloud we do not trust, which is a
 * denial.
 *
 * Anything short of a report at all is `pending`, not `denied`: "we have not
 * looked yet" and "we looked and refused" are different things to tell an
 * operator, and only the second one is a verdict.
 *
 * So is `digest-not-pinned` (SUP-252): the sidecar looked, and what it is waiting
 * for is the admin's approval of the deployment it saw, not a better upstream.
 * Calling that a denial would make every fresh registration read as a failure.
 * Admission is unaffected — `pending` serves nothing, exactly like `denied`.
 */
export function statusOf(verdict: SidecarVerdict): ExternalEndpointStatus {
  if (verdict.admitted) {
    return 'verified';
  }
  if (!verdict.report || verdict.report.refusal === 'digest-not-pinned') {
    return 'pending';
  }
  return 'denied';
}

/** The clock a projection is formed against. */
export interface ProjectionClock {
  /**
   * Passed in rather than read, so the events a test asserts on have the
   * timestamps the test chose.
   */
  now: Date;
  /**
   * How old a verdict's own `checkedAt` may be and still admit — see
   * {@link VERDICT_ATTEST_INTERVALS}. Zero turns the bound off, which nothing in
   * production does; a test about something else passes zero so that its
   * fixtures' timestamps stay irrelevant.
   */
  attestWindowMs: number;
}

/**
 * Projects a verdict onto the row it is about.
 */
export function projectVerdict(
  endpoint: ExternalEndpoint,
  verdict: SidecarVerdict,
  clock: ProjectionClock,
): ProjectedVerdict {
  const { now } = clock;
  const report = verdict.report;
  const check = checkOf(report, now);
  const expired = expiredAdmission(verdict, check, clock);
  // An admission whose own check is too old is not an admission. Withdrawing it
  // here rather than a step later is what stops the two from fighting: a pass
  // that admitted the verdict and then expired the row would write a `verified`
  // and a `verdict_expired` every five seconds for ever, and — because every one
  // of them restarts `notServingSince` — the outage this is supposed to raise
  // would never age into one. See {@link expireVerdict} for the other half, the
  // one the reader rather than the verdict is responsible for.
  const status = expired ? 'pending' : statusOf(verdict);
  const measurement = report?.attestedRoot?.measurement ?? null;
  const evidenceDigest = report?.evidenceDigest ?? null;

  const patch: ExternalEndpointStatusPatch = {
    status,
    // The sidecar's own timestamp when it has one. With a report but no timestamp,
    // `now` is the honest stand-in — a check did happen. With no report at all
    // nothing has been checked, so the row keeps whatever it had: writing `now`
    // there would both claim a check that never ran and make every five-second
    // poll of an `attesting` endpoint look like a change worth an `UPDATE`.
    lastCheckedAt: check?.at ?? endpoint.lastCheckedAt,
    // The refused factor when the two-factor clause names one — it is the more
    // specific answer, and the one an operator acts on (`digest-mismatch` means
    // "approve the new digest", `policy` would mean nothing in particular).
    // Null for an expired admission: no stage refused it, the clock did, and a
    // stage here would send an operator looking for a refusal that never happened.
    lastStage: expired ? null : (report?.refusal ?? report?.stage ?? null),
    // The sidecar's one-line denial, or nothing when it admitted. Clipped to the
    // column: a reason is for a human to read, not a payload to carry.
    //
    // The expiry sentence names `checkedAt` and not `now`, so a pass that reads
    // the same frozen verdict again produces the same row and writes nothing.
    lastReason: expired ?? clip(verdict.reason ?? report?.reason ?? null, 255),
    measurementSeen: measurement,
    measurementSource: report?.attestedRoot?.measurementSource ?? null,
    // Only meaningful about a measurement: with none derived, "not in the
    // registry" would be a claim about nothing.
    measurementInRegistry: measurement ? (report?.attestedRoot?.inRegistry ?? false) : null,
    evidenceDigestSeen: evidenceDigest,
    // Only an admitted verdict pins a leaf. Keeping a stale fingerprint on a
    // denied endpoint would read as "this is what we are pinned to" about an
    // endpoint that is refusing traffic.
    pinnedCertFingerprint: status === 'verified' ? (report?.certFingerprint ?? null) : null,
    // Wider than the pin: any report whose cryptography held — the channel
    // binding included — bound its evidence to this leaf, admitted or not. It is
    // what lets the console file and show the deployment a two-factor refusal is
    // asking an admin to approve (SUP-252). A pipeline failure binds nothing.
    observedCertFingerprint: report?.verified ? (report.certFingerprint ?? null) : null,
    // The sidecar's own answer, not an inference from the stage (SUP-517, and the
    // narrowing in SUP-422): `fetch` also covers a non-2xx answer to the bundle
    // fetch and an over-sized bundle, which are an upstream answering badly. The
    // flag is `omitempty` on the wire, so a report that carries one and omits
    // this is a reachable upstream; no report at all leaves the column null,
    // which is the third answer — nothing has been checked.
    upstreamUnreachable: report ? (report.unreachable ?? false) : endpoint.upstreamUnreachable,
    ...runOf(endpoint, status, check),
  };

  const events: ProjectedEvent[] = [];
  const at = (kind: ExternalEndpointEventKind): ProjectedEvent => ({
    kind,
    stage: patch.lastStage,
    reason: patch.lastReason,
    measurement,
    evidenceDigest,
  });

  const statusChanged = endpoint.status !== status;
  if (statusChanged && expired) {
    // `pending` is normally the one status that writes no event — "not checked"
    // is where a row starts, and announcing it would be noise. This is the
    // exception: the row *was* admitting and has stopped, and an operator whose
    // model just left `/v1/models` is owed the reason in the one place they will
    // look for it.
    events.push(at('verdict_expired'));
  } else if (statusChanged && status !== 'pending') {
    events.push(at(status === 'verified' ? 'verified' : 'denied'));
  }
  // Reported whether or not the status moved: a redeploy is the change an
  // operator approves or refuses, so it is named in its own right beside the
  // denial a mismatched pin produces.
  if (evidenceDigest && endpoint.evidenceDigestSeen && endpoint.evidenceDigestSeen !== evidenceDigest) {
    events.push(at('digest_changed'));
  }
  if (measurement && endpoint.measurementSeen && endpoint.measurementSeen !== measurement) {
    events.push(at('measurement_changed'));
  }

  return { patch, events, statusChanged, patchChanged: differs(endpoint, patch) };
}

/**
 * How many polls a `verified` row keeps its verdict for once the sidecar stops
 * confirming it (SUP-583).
 *
 * Derived from `externalEndpoints.statusPollInterval` rather than configured, so
 * that the window cannot drift out of step with the thing it counts — and so
 * that enforcing ADR-008 §8 costs the attested `router.yaml` no new key and
 * nobody a re-pin. Twelve at the default five seconds is a minute: generous
 * enough that a slow pass, a reload or a restarting sidecar is never why a
 * model disappears, short enough that a wedged one does not keep selling an
 * upstream nothing has re-checked.
 */
export const VERDICT_GRACE_POLLS = 12;

/**
 * …and never shorter than this, so a deployment that polls every 200 ms does not
 * end up with a two-and-a-half-second grace and flap its own catalogue.
 */
export const VERDICT_GRACE_FLOOR_MS = 30_000;

export function verdictGraceMs(statusPollIntervalMs: number): number {
  return Math.max(VERDICT_GRACE_FLOOR_MS, statusPollIntervalMs * VERDICT_GRACE_POLLS);
}

/**
 * How many re-attestation intervals a verdict's own check may be behind before
 * the verdict stops counting (SUP-583).
 *
 * The second way a verdict goes stale, and it does not look like the first at
 * all: `/verdicts` answers, every poll succeeds, and the `checkedAt` inside the
 * answer stops moving — a sidecar whose re-attestation loop is wedged while its
 * admin API is not. Read recency alone cannot see it, because the reads are
 * fine; this is the bound on the verdict rather than on the conversation.
 *
 * Three rather than one because a re-attestation is not instant and does not
 * land on a tick: the loop arms the next one after the last verdict, an upstream
 * that is slow to answer pushes it out, and a single missed cycle is not news.
 * Thirty minutes at the default ten, and never the single-interval bound that
 * would retire healthy verdicts on ordinary jitter.
 */
export const VERDICT_ATTEST_INTERVALS = 3;

export function verdictAttestWindowMs(reattestIntervalMs: number): number {
  return reattestIntervalMs * VERDICT_ATTEST_INTERVALS;
}

/** When a verdict was last read back, how long it may go unread, and now. */
export interface VerdictClock {
  /**
   * When this router last read a verdict naming this endpoint, or null when it
   * never has in this process.
   *
   * **Not `lastCheckedAt`**, which is the *sidecar's* own timestamp and is ten
   * minutes old on a perfectly healthy endpoint — `reattestInterval` is ten
   * minutes, and a verdict being that old is the design rather than a fault.
   * What expires a verdict is this router no longer being handed it, which only
   * the reader can know. The age of the verdict itself is the other half, and it
   * is {@link ProjectionClock.attestWindowMs} that bounds it — in the projection,
   * because a verdict too old to be current must not be admitted in the first
   * place.
   */
  confirmedAt: Date | null;
  graceMs: number;
  now: Date;
}

/**
 * Lets go of a verdict the sidecar has stopped confirming (SUP-583).
 *
 * The rule ADR-008 §8 states and this is the enforcement of: **a stored status
 * is never trust.** `verified` on a row means "the sidecar holds an admitting
 * verdict for this upstream right now", and `/verdicts` being re-read is the
 * entirety of what makes that present tense true. {@link projectVerdict} keeps
 * it true while answers arrive; nothing kept it true when they stopped.
 *
 * Without this, a sidecar that wedges leaves every row exactly as the last
 * answer left it, for ever: the boot reset is the only thing that ever clears a
 * verdict, so one that outlives the restart that produced it is simply believed.
 * `models { available }` stays true, `/v1/models` keeps listing the model and
 * admission keeps proxying prompts to an upstream whose evidence this router can
 * no longer verify — which is the one thing the attested egress exists to
 * prevent. It is also silent: the outage alert keys on `notServingSince`, and a
 * `verified` row has none.
 *
 * Expiring is not a verdict about the upstream, and the patch says so. The row
 * goes back to `pending` — "not checked", the state every row boots in — with
 * `lastCheckedAt` cleared, so `reachabilityOf` reads `unknown` rather than
 * asserting anything about a cloud nobody asked. `consecutiveFailures` stays at
 * zero for the same reason: no check failed, the checking stopped.
 * `lastSuccessAt` and `lastFailureAt` are kept, because when this upstream last
 * served is history and remains true.
 *
 * `notServingSince` is set to `now` and that is the half that wakes somebody:
 * from here the ordinary outage threshold runs, and an upstream that stops being
 * re-verified alerts by the same path as one that stops answering.
 *
 * **One of the two ways the present tense stops being true, and the only one a
 * reader can see.** The sidecar can stop answering, which is this; or it can keep
 * answering with a verdict whose own `checkedAt` has stopped moving, which looks
 * nothing like it — every poll succeeds and nothing about the conversation is
 * wrong. That one is caught where the verdict is turned into a status, by
 * {@link expiredAdmission}, because the fix for it is to stop admitting rather
 * than to admit and then withdraw: a pass that did both would write a `verified`
 * and a `verdict_expired` every five seconds and restart the outage clock on each
 * one. Both land on the same timeline kind, with reasons that say which happened.
 *
 * @returns null when the row holds no verdict to lose, or holds one young
 *   enough. A pass calls this on every row and writes only what it returns.
 */
export function expireVerdict(endpoint: ExternalEndpoint, clock: VerdictClock): ProjectedVerdict | null {
  const { confirmedAt, graceMs, now } = clock;
  if (endpoint.status !== 'verified') {
    return null;
  }
  if (confirmedAt && now.getTime() - confirmedAt.getTime() < graceMs) {
    return null;
  }
  const why =
    'the egress sidecar has not confirmed it since ' +
    `${confirmedAt ? confirmedAt.toISOString() : 'this router started'}.`;

  const reason = clip(`Verdict expired: ${why} Every model on this endpoint is refused until it does.`, 255);
  const patch: ExternalEndpointStatusPatch = {
    status: 'pending',
    lastStage: null,
    lastReason: reason,
    measurementSeen: null,
    measurementSource: null,
    measurementInRegistry: null,
    evidenceDigestSeen: null,
    pinnedCertFingerprint: null,
    observedCertFingerprint: null,
    lastCheckedAt: null,
    lastSuccessAt: endpoint.lastSuccessAt,
    lastFailureAt: endpoint.lastFailureAt,
    notServingSince: now,
    consecutiveFailures: 0,
    upstreamUnreachable: null,
  };

  return {
    patch,
    events: [
      {
        kind: 'verdict_expired',
        stage: null,
        reason,
        measurement: null,
        // The deployment whose verdict just lapsed, so the timeline names what
        // stopped being believed rather than only that something did.
        evidenceDigest: endpoint.evidenceDigestSeen,
      },
    ],
    statusChanged: true,
    patchChanged: true,
  };
}

/**
 * What a verdict reports having done, as the run projection needs it.
 *
 * Two facts that have to travel together. `at` is the instant the row records,
 * falling back to `now` when the report omitted its own timestamp — a check did
 * happen, and refusing to date it would be worse. `stamped` is whether that
 * instant came from the sidecar, and it is what the failure counter keys on: an
 * unstamped report cannot be told apart from the previous one, so counting it
 * would make `outage.afterFailures: 3` trip in fifteen seconds of polling —
 * exactly what counting distinct checks exists to prevent. The core emits
 * `checkedAt` unconditionally, so this guards the seam rather than a live case.
 */
interface ReportedCheck {
  at: Date;
  stamped: boolean;
}

function checkOf(report: SidecarReport | undefined, now: Date): ReportedCheck | null {
  if (!report) {
    return null;
  }
  return report.checkedAt ? { at: new Date(report.checkedAt), stamped: true } : { at: now, stamped: false };
}

/**
 * Why an otherwise-admitting verdict no longer admits, or null while it does
 * (SUP-583).
 *
 * The sidecar can wedge in a way that leaves its admin API perfectly healthy:
 * `/verdicts` answers on every poll, and the `checkedAt` inside the answer never
 * moves. Nothing about the conversation looks wrong, so read recency — the other
 * half of this rule, in {@link expireVerdict} — sees nothing at all. What is
 * stale is the verdict itself, and only its own timestamp shows it.
 *
 * **Only an admission is withdrawn.** A denial whose `checkedAt` is old refuses
 * traffic either way, and relabelling it `pending` would throw away the stage an
 * operator acts on. The same goes for a verdict that is already `pending`: there
 * is nothing there to withdraw.
 *
 * The sentence is the return value because it becomes `lastReason` and the
 * timeline row, and it must not mention `now`: a pass that reads the same frozen
 * verdict again has to produce the same row, or every poll would be a write.
 */
function expiredAdmission(verdict: SidecarVerdict, check: ReportedCheck | null, clock: ProjectionClock): string | null {
  const { now, attestWindowMs } = clock;
  if (attestWindowMs <= 0 || !verdict.admitted || check === null) {
    return null;
  }
  if (now.getTime() - check.at.getTime() < attestWindowMs) {
    return null;
  }
  return clip(
    'Verdict expired: the egress sidecar is answering, but the verdict it keeps repeating was formed at ' +
      `${check.at.toISOString()} and has not been re-attested since. ` +
      'Every model on this endpoint is refused until it is.',
    255,
  );
}

/** The four columns of {@link ExternalEndpointStatusPatch} that describe the *run* rather than the check. */
type RunPatch = Pick<
  ExternalEndpointStatusPatch,
  'lastSuccessAt' | 'lastFailureAt' | 'notServingSince' | 'consecutiveFailures'
>;

/**
 * Projects one verdict onto the failure-run columns (SUP-517).
 *
 * The rule in one line: a verdict that admits closes the run, a verdict that
 * denies extends it, and a `pending` verdict starts one without counting against
 * it. Spelled out:
 *
 * - **verified** — the run is over. `lastSuccessAt` moves to this check,
 *   `notServingSince` clears and the counter goes to zero. `lastFailureAt` is
 *   kept: it is the only column that survives a recovery, and "this upstream has
 *   been flapping" is a thing an operator needs the row to be able to say.
 * - **denied** — `lastFailureAt` moves, the counter advances **only on a new
 *   check**, and `notServingSince` is left alone once set, because the run began
 *   at the first failure and not at the hundredth reading of it.
 * - **pending** — nothing is counted. A `pending` endpoint is one this router has
 *   not checked or whose deployment an admin has not approved; neither is the
 *   upstream's failure, so neither advances a counter whose threshold pages.
 *   `notServingSince` is still started, because a pending endpoint serves nothing
 *   and a caller cannot tell why (`expectedToServe` is what keeps that quiet).
 *
 * @param check what the verdict reports having done, or null when it carried no
 *   report at all — then nothing happened and every column keeps what it had.
 */
function runOf(endpoint: ExternalEndpoint, status: ExternalEndpointStatus, check: ReportedCheck | null): RunPatch {
  const unchanged: RunPatch = {
    lastSuccessAt: endpoint.lastSuccessAt,
    lastFailureAt: endpoint.lastFailureAt,
    notServingSince: endpoint.notServingSince,
    consecutiveFailures: endpoint.consecutiveFailures,
  };
  if (check === null) {
    return unchanged;
  }
  const { at: checkedAt } = check;
  if (status === 'verified') {
    return { ...unchanged, lastSuccessAt: checkedAt, notServingSince: null, consecutiveFailures: 0 };
  }
  if (status === 'pending') {
    return { ...unchanged, notServingSince: endpoint.notServingSince ?? checkedAt };
  }
  // A re-read of the verdict already on the row is not a second failure: the
  // status poll runs every 5 s against a re-attestation every 10 minutes, so
  // counting readings would make `outage.afterFailures` a number of seconds
  // wearing a different name. An unstamped report counts as a re-read for the
  // same reason — see {@link ReportedCheck.stamped}.
  const isNewCheck = check.stamped && endpoint.lastCheckedAt?.getTime() !== checkedAt.getTime();
  return {
    ...unchanged,
    lastFailureAt: checkedAt,
    notServingSince: endpoint.notServingSince ?? checkedAt,
    consecutiveFailures: endpoint.consecutiveFailures + (isNewCheck ? 1 : 0),
  };
}

/** Whether any column the patch names holds a different value on the row already. */
function differs(endpoint: ExternalEndpoint, patch: ExternalEndpointStatusPatch): boolean {
  return Object.entries(patch).some(([key, value]) => {
    const current = endpoint[key as keyof ExternalEndpointStatusPatch];
    // `lastCheckedAt` is the one `Date`, and two equal instants are two objects.
    if (value instanceof Date || current instanceof Date) {
      return (value as Date | null)?.getTime() !== (current as Date | null)?.getTime();
    }
    return value !== current;
  });
}

/**
 * Keeps a reason inside `external_endpoint_events.reason` / `lastReason`, both
 * varchar(255). Exported because the reasons a mutation writes are as long as the
 * base URLs they quote, and one column should not have two guards.
 */
export function clip(value: string | null, length: number): string | null {
  if (!value) {
    return null;
  }
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
