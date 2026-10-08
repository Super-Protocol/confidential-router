import type { ExternalEndpoint, ExternalEndpointStatus } from '../db/entities/external-endpoint.entity.js';
import type { ExternalEndpointEventKind } from '../db/entities/external-endpoint-event.entity.js';
import type { SidecarVerdict } from './sidecar-admin.client.js';

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

/**
 * Projects a verdict onto the row it is about.
 *
 * `now` is passed in rather than read, so the events a test asserts on have the
 * timestamps the test chose.
 */
export function projectVerdict(
  endpoint: ExternalEndpoint,
  verdict: SidecarVerdict,
  now: Date = new Date(),
): ProjectedVerdict {
  const report = verdict.report;
  const status = statusOf(verdict);
  const measurement = report?.attestedRoot?.measurement ?? null;
  const evidenceDigest = report?.evidenceDigest ?? null;

  const patch: ExternalEndpointStatusPatch = {
    status,
    // The sidecar's own timestamp when it has one. With a report but no timestamp,
    // `now` is the honest stand-in — a check did happen. With no report at all
    // nothing has been checked, so the row keeps whatever it had: writing `now`
    // there would both claim a check that never ran and make every five-second
    // poll of an `attesting` endpoint look like a change worth an `UPDATE`.
    lastCheckedAt: report ? (report.checkedAt ? new Date(report.checkedAt) : now) : endpoint.lastCheckedAt,
    // The refused factor when the two-factor clause names one — it is the more
    // specific answer, and the one an operator acts on (`digest-mismatch` means
    // "approve the new digest", `policy` would mean nothing in particular).
    lastStage: report?.refusal ?? report?.stage ?? null,
    // The sidecar's one-line denial, or nothing when it admitted. Clipped to the
    // column: a reason is for a human to read, not a payload to carry.
    lastReason: clip(verdict.reason ?? report?.reason ?? null, 255),
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
  if (statusChanged && status !== 'pending') {
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

function clip(value: string | null, length: number): string | null {
  if (!value) {
    return null;
  }
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
