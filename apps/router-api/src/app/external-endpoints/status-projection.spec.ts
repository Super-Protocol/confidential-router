import { describe, expect, it } from 'vitest';
import type { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import type { SidecarVerdict } from './sidecar-admin.client.js';
import { projectVerdict, statusOf, VERDICT_GRACE_FLOOR_MS, verdictGraceMs } from './status-projection.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');

/**
 * The clock these projections are formed against, with the attest window off.
 *
 * Off because every case below is about what a verdict projects onto a row, not
 * about its age — see the `an admission its own check has outlived` block for
 * the cases that are. Production always passes a window
 * (`verdictAttestWindowMs`); zero is how a test says "not my concern".
 */
const AT = { now: NOW, attestWindowMs: 0 };
const MEASUREMENT = 'a'.repeat(64);
const OTHER_MEASUREMENT = 'b'.repeat(64);
const DIGEST = 'sha256/BvG0Yy3Ir0QKPtC1TrSPuyZZD1sdKq7Gq_a1Mv1Hs0A';
const OTHER_DIGEST = 'sha256/CwH1Zz4Js1RLQudD2UsTQvzaaE2teLr8Hr_b2Nw2It1B';
const FINGERPRINT = 'sha256/leafleafleafleafleafleafleafleafleafleafle0';

/**
 * A freshly registered row, as the driver hands one back: every verdict column
 * explicitly `null` rather than absent, because `projectVerdict` compares the
 * patch against them and `undefined` would read as a change.
 */
function endpoint(overrides: Partial<ExternalEndpoint> = {}): ExternalEndpoint {
  return {
    name: 'upstream-a',
    status: 'pending',
    lastCheckedAt: null,
    lastStage: null,
    lastReason: null,
    measurementSeen: null,
    measurementSource: null,
    measurementInRegistry: null,
    evidenceDigestSeen: null,
    pinnedCertFingerprint: null,
    observedCertFingerprint: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    notServingSince: null,
    consecutiveFailures: 0,
    upstreamUnreachable: null,
    ...overrides,
  } as ExternalEndpoint;
}

function admitted(overrides: Partial<SidecarVerdict> = {}): SidecarVerdict {
  return {
    endpoint: 'upstream-a',
    health: 'confidential',
    admitted: true,
    report: {
      checkedAt: '2026-10-06T11:59:58.000Z',
      verified: true,
      admitted: true,
      attestedRoot: { measurement: MEASUREMENT, measurementSource: 'operator-pinned', inRegistry: false },
      certFingerprint: FINGERPRINT,
      observedTlsFingerprint: FINGERPRINT,
      evidenceDigest: DIGEST,
    },
    ...overrides,
  };
}

function denied(overrides: Partial<SidecarVerdict> = {}): SidecarVerdict {
  return {
    endpoint: 'upstream-a',
    health: 'broken',
    admitted: false,
    reason: 'policy: the built-in pin policy (gatekeeper.default) denied',
    report: {
      checkedAt: '2026-10-06T11:59:58.000Z',
      verified: true,
      admitted: false,
      stage: 'policy',
      reason: 'measurement is not in the trusted list',
      attestedRoot: { measurement: OTHER_MEASUREMENT, inRegistry: false },
      evidenceDigest: DIGEST,
    },
    ...overrides,
  };
}

describe('statusOf', () => {
  it('reads admission, not verification', () => {
    // `verified` is the cryptography (stages 1–6); `admitted` additionally
    // requires policy — and the admin-list check is a policy clause. So sound
    // evidence from an untrusted cloud is a denial, not a pass.
    expect(statusOf(admitted())).toBe('verified');
    expect(statusOf(denied())).toBe('denied');
  });

  it('calls a verdict with no report pending, not denied', () => {
    // "We have not looked yet" and "we looked and refused" are different things
    // to tell an operator, and only the second one is a verdict.
    expect(statusOf({ endpoint: 'upstream-a', health: 'attesting', admitted: false })).toBe('pending');
  });
});

/** A built-in two-factor denial, refused on `refusal` (SUP-252). */
function refused(refusal: 'digest-not-pinned' | 'measurement-not-trusted' | 'digest-mismatch'): SidecarVerdict {
  const verdict = denied();
  return { ...verdict, report: { ...verdict.report, attestedRoot: { measurement: MEASUREMENT }, refusal } };
}

describe('two-factor refusals', () => {
  it('holds an endpoint whose deployment nobody approved at pending, not denied', () => {
    // The sidecar looked and is waiting for the admin, not for a better upstream:
    // a fresh registration must not read as a failure. It still serves nothing.
    const { patch, events } = projectVerdict(endpoint(), refused('digest-not-pinned'), AT);

    expect(statusOf(refused('digest-not-pinned'))).toBe('pending');
    expect(patch.status).toBe('pending');
    expect(patch.lastStage).toBe('digest-not-pinned');
    // Both factors the admin approves are on the row, which is what the dossier
    // offers its two buttons from.
    expect(patch.measurementSeen).toBe(MEASUREMENT);
    expect(patch.evidenceDigestSeen).toBe(DIGEST);
    expect(patch.lastCheckedAt).toEqual(new Date('2026-10-06T11:59:58.000Z'));
    expect(events).toEqual([]);
  });

  it('denies on an untrusted cloud and names the factor as the stage', () => {
    const { patch } = projectVerdict(endpoint(), refused('measurement-not-trusted'), AT);

    expect(patch.status).toBe('denied');
    expect(patch.lastStage).toBe('measurement-not-trusted');
  });

  it('fails a redeploy closed: digest-mismatch, the denial and the digest change, together', () => {
    // The beat two-factor exists for (T13): the cloud is unchanged, the upstream
    // redeployed, and the pin no longer matches. The DIGEST_CHANGED event is now
    // gating — it arrives with the denial it caused.
    const { patch, events, statusChanged } = projectVerdict(
      endpoint({
        status: 'verified',
        measurementSeen: MEASUREMENT,
        evidenceDigestSeen: OTHER_DIGEST,
        pinnedCertFingerprint: FINGERPRINT,
      }),
      refused('digest-mismatch'),
      AT,
    );

    expect(statusChanged).toBe(true);
    expect(patch.status).toBe('denied');
    expect(patch.lastStage).toBe('digest-mismatch');
    expect(patch.pinnedCertFingerprint).toBeNull();
    expect(events.map((event) => event.kind)).toEqual(['denied', 'digest_changed']);
    expect(events.every((event) => event.stage === 'digest-mismatch')).toBe(true);
  });

  it('keeps the pipeline stage for a failure that is not a trust answer', () => {
    // No `refusal` on a fetch or channel failure: neither factor was the question.
    const failed = denied();
    const verdict = { ...failed, report: { ...failed.report, verified: false, stage: 'tls-fingerprint' } };

    expect(projectVerdict(endpoint(), verdict, AT).patch.lastStage).toBe('tls-fingerprint');
  });
});

describe('projectVerdict', () => {
  it('writes the observed measurement, digest and pinned leaf on an admission', () => {
    const { patch } = projectVerdict(endpoint(), admitted(), AT);

    expect(patch).toEqual({
      status: 'verified',
      lastCheckedAt: new Date('2026-10-06T11:59:58.000Z'),
      lastStage: null,
      lastReason: null,
      measurementSeen: MEASUREMENT,
      measurementSource: 'operator-pinned',
      measurementInRegistry: false,
      evidenceDigestSeen: DIGEST,
      pinnedCertFingerprint: FINGERPRINT,
      observedCertFingerprint: FINGERPRINT,
      // The run closes: this check is the success, nothing is outstanding, and
      // the counter goes back to zero (SUP-517).
      lastSuccessAt: new Date('2026-10-06T11:59:58.000Z'),
      lastFailureAt: null,
      notServingSince: null,
      consecutiveFailures: 0,
      // Read from the report, which omits the flag when the upstream answered.
      upstreamUnreachable: false,
    });
  });

  it('records the stage and reason of a denial, and pins nothing', () => {
    // A fingerprint left over from an earlier admission would read as "this is
    // what we are pinned to" about an endpoint that is refusing traffic.
    const { patch } = projectVerdict(
      endpoint({ status: 'verified', pinnedCertFingerprint: FINGERPRINT }),
      denied(),
      AT,
    );

    expect(patch.status).toBe('denied');
    expect(patch.lastStage).toBe('policy');
    expect(patch.lastReason).toContain('denied');
    expect(patch.pinnedCertFingerprint).toBeNull();
  });

  it('carries the registry signal on a denial, without it admitting anything', () => {
    // SUP-251: the dossier shows "Registry-signed" beside a denied endpoint's
    // measurement. `measurementSource` is empty on a denial — it names only the
    // anchor that admitted — so `inRegistry` is the one place the signal lives.
    const signed = denied();
    signed.report = { ...signed.report, attestedRoot: { measurement: OTHER_MEASUREMENT, inRegistry: true } };

    const { patch } = projectVerdict(endpoint(), signed, AT);

    expect(patch.status).toBe('denied');
    expect(patch.measurementInRegistry).toBe(true);
    expect(patch.measurementSource).toBeNull();
  });

  it('reads an unreported registry flag as false, and states nothing without a measurement', () => {
    const unflagged = denied();
    unflagged.report = { ...unflagged.report, attestedRoot: { measurement: OTHER_MEASUREMENT } };
    expect(projectVerdict(endpoint(), unflagged, AT).patch.measurementInRegistry).toBe(false);

    const noMeasurement = denied();
    noMeasurement.report = { ...noMeasurement.report, stage: 'untrusted-root', attestedRoot: undefined };
    expect(projectVerdict(endpoint(), noMeasurement, AT).patch.measurementInRegistry).toBeNull();
  });

  it('falls back to now when the report carries no timestamp', () => {
    const { patch } = projectVerdict(endpoint(), admitted({ report: { admitted: true } }), AT);

    expect(patch.lastCheckedAt).toEqual(NOW);
  });

  it('claims no check at all while the sidecar is still attesting', () => {
    // A row with no report has not been checked, so `lastCheckedAt` has to stay
    // where it was. Writing `now` would claim a check that never ran — and, since
    // `now` advances, would make every five-second poll of an attesting endpoint
    // look like a change worth an `UPDATE`.
    const attesting: SidecarVerdict = { endpoint: 'upstream-a', health: 'attesting', admitted: false };

    const fresh = projectVerdict(endpoint(), attesting, AT);
    expect(fresh.patch.lastCheckedAt).toBeNull();
    expect(fresh.patchChanged).toBe(false);

    const previously = new Date('2026-10-06T11:00:00.000Z');
    const seen = projectVerdict(endpoint({ lastCheckedAt: previously }), attesting, AT);
    expect(seen.patch.lastCheckedAt).toEqual(previously);
  });

  it('clips a reason to the column rather than letting an insert fail', () => {
    const long = 'x'.repeat(400);
    const { patch } = projectVerdict(endpoint(), denied({ reason: long }), AT);

    expect(patch.lastReason).toHaveLength(255);
    expect(patch.lastReason?.endsWith('…')).toBe(true);
  });

  it('writes one event on a flip, and reports the flip', () => {
    const verified = projectVerdict(endpoint(), admitted(), AT);
    expect(verified.statusChanged).toBe(true);
    expect(verified.events.map((event) => event.kind)).toEqual(['verified']);

    const refused = projectVerdict(endpoint({ status: 'verified' }), denied(), AT);
    expect(refused.statusChanged).toBe(true);
    expect(refused.events.map((event) => event.kind)).toEqual(['denied']);
  });

  it('reports an unchanged patch, so a repeated poll writes nothing at all', () => {
    // The poll runs every five seconds and a re-attestation every ten minutes, so
    // most passes see exactly the verdict they saw last time.
    const unchanged = endpoint({
      status: 'verified',
      lastCheckedAt: new Date('2026-10-06T11:59:58.000Z'),
      lastStage: null,
      lastReason: null,
      measurementSeen: MEASUREMENT,
      measurementSource: 'operator-pinned',
      measurementInRegistry: false,
      evidenceDigestSeen: DIGEST,
      pinnedCertFingerprint: FINGERPRINT,
      observedCertFingerprint: FINGERPRINT,
      lastSuccessAt: new Date('2026-10-06T11:59:58.000Z'),
      notServingSince: null,
      consecutiveFailures: 0,
      upstreamUnreachable: false,
    });

    expect(projectVerdict(unchanged, admitted(), AT).patchChanged).toBe(false);
  });

  it('compares a timestamp by its instant, not by object identity', () => {
    // `lastCheckedAt` comes back from the driver as a fresh `Date` every read, so
    // an identity comparison would call every poll a change and defeat the check.
    const row = endpoint({ status: 'pending', lastCheckedAt: new Date('2026-10-06T11:59:58.000Z') });

    const { patch, patchChanged } = projectVerdict(row, admitted(), AT);

    expect(patch.lastCheckedAt).toEqual(row.lastCheckedAt);
    // The status still moved, so the patch as a whole did change.
    expect(patchChanged).toBe(true);
  });

  it('reports a changed patch when only the check time moved', () => {
    const row = endpoint({
      status: 'verified',
      lastCheckedAt: new Date('2026-10-06T11:49:58.000Z'),
      measurementSeen: MEASUREMENT,
      measurementSource: 'operator-pinned',
      measurementInRegistry: false,
      evidenceDigestSeen: DIGEST,
      pinnedCertFingerprint: FINGERPRINT,
    });

    expect(projectVerdict(row, admitted(), AT).patchChanged).toBe(true);
  });

  it('writes no event when the verdict only repeats itself', () => {
    // At a ten-minute TTL a stable endpoint re-attests 144 times a day, and a row
    // per check would bury the changes an operator is looking for.
    const { events, statusChanged } = projectVerdict(
      endpoint({ status: 'verified', measurementSeen: MEASUREMENT, evidenceDigestSeen: DIGEST }),
      admitted(),
      AT,
    );

    expect(statusChanged).toBe(false);
    expect(events).toEqual([]);
  });

  it('reports a digest change even while the endpoint stays verified', () => {
    // An admin approving the new digest ahead of the redeploy keeps the endpoint
    // verified across it — and the change is still named in the timeline.
    const { events, statusChanged } = projectVerdict(
      endpoint({ status: 'verified', measurementSeen: MEASUREMENT, evidenceDigestSeen: OTHER_DIGEST }),
      admitted(),
      AT,
    );

    expect(statusChanged).toBe(false);
    expect(events.map((event) => event.kind)).toEqual(['digest_changed']);
    expect(events[0].evidenceDigest).toBe(DIGEST);
  });

  it('reports a measurement change', () => {
    const { events } = projectVerdict(
      endpoint({ status: 'verified', measurementSeen: OTHER_MEASUREMENT, evidenceDigestSeen: DIGEST }),
      admitted(),
      AT,
    );

    expect(events.map((event) => event.kind)).toEqual(['measurement_changed']);
  });

  it('does not call the first observation a change', () => {
    // A fresh row has seen nothing; calling that a `digest_changed` would put a
    // change in the timeline of every endpoint ever registered.
    const { events } = projectVerdict(endpoint(), admitted(), AT);

    expect(events.map((event) => event.kind)).toEqual(['verified']);
  });

  it('never writes an event for a flip back to pending', () => {
    // Only this process restarted, which is not news about the upstream.
    const { events, patch } = projectVerdict(
      endpoint({ status: 'verified' }),
      { endpoint: 'upstream-a', health: 'attesting', admitted: false },
      AT,
    );

    expect(patch.status).toBe('pending');
    expect(events).toEqual([]);
  });
});

describe('projectVerdict and the failure run (SUP-517)', () => {
  const CHECKED = new Date('2026-10-06T11:59:58.000Z');
  const LATER = new Date('2026-10-06T12:09:58.000Z');

  it('opens a run on the first denial and dates it from the check, not the poll', () => {
    const { patch } = projectVerdict(endpoint({ status: 'verified', lastSuccessAt: CHECKED }), denied(), AT);

    expect(patch).toMatchObject({
      status: 'denied',
      lastFailureAt: CHECKED,
      notServingSince: CHECKED,
      consecutiveFailures: 1,
      // Kept: it is what "has not served for 31m" is measured against, and the
      // only column a later recovery does not clear.
      lastSuccessAt: CHECKED,
    });
  });

  it('counts a re-attestation, not a poll', () => {
    // The poll runs every 5 s against a re-attestation every 10 minutes. Counting
    // readings would make `outage.afterFailures` a number of seconds wearing a
    // different name — three would be reached fifteen seconds in.
    const failing = endpoint({
      status: 'denied',
      lastCheckedAt: CHECKED,
      lastStage: 'policy',
      notServingSince: CHECKED,
      lastFailureAt: CHECKED,
      consecutiveFailures: 1,
    });

    const repeat = projectVerdict(failing, denied(), AT);
    expect(repeat.patch.consecutiveFailures).toBe(1);
    // And the run keeps its start: it began at the first failure, not at the
    // hundredth reading of it.
    expect(repeat.patch.notServingSince).toEqual(CHECKED);

    const next = { ...denied(), report: { ...denied().report, checkedAt: LATER.toISOString() } };
    expect(projectVerdict(failing, next, AT).patch.consecutiveFailures).toBe(2);
  });

  it('closes the run on an admission and keeps the last failure', () => {
    const recovering = endpoint({
      status: 'denied',
      lastCheckedAt: new Date('2026-10-06T11:49:58.000Z'),
      notServingSince: new Date('2026-10-06T11:29:58.000Z'),
      lastFailureAt: new Date('2026-10-06T11:49:58.000Z'),
      consecutiveFailures: 4,
    });

    expect(projectVerdict(recovering, admitted(), AT).patch).toMatchObject({
      status: 'verified',
      lastSuccessAt: CHECKED,
      notServingSince: null,
      consecutiveFailures: 0,
      lastFailureAt: new Date('2026-10-06T11:49:58.000Z'),
    });
  });

  it('starts the clock on a pending verdict without counting it as a failure', () => {
    // `digest-not-pinned` is this router waiting for an admin, not the upstream
    // failing. It serves nothing, so the clock runs; it is nobody's fault, so the
    // counter does not — and `expectedToServe` is what keeps it off the pager.
    const awaiting = {
      ...admitted(),
      admitted: false,
      report: { ...admitted().report, admitted: false, refusal: 'digest-not-pinned' as const },
    };

    expect(projectVerdict(endpoint(), awaiting, AT).patch).toMatchObject({
      status: 'pending',
      notServingSince: CHECKED,
      consecutiveFailures: 0,
      lastFailureAt: null,
    });
  });

  it('leaves the whole run alone when the verdict carries no report at all', () => {
    // Nothing was checked, so nothing happened: writing a failure here would
    // claim a check that never ran.
    const row = endpoint({ status: 'pending', notServingSince: CHECKED, consecutiveFailures: 2 });
    const unchecked = { endpoint: 'upstream-a', health: 'attesting' as const, admitted: false };

    expect(projectVerdict(row, unchecked, AT).patch).toMatchObject({
      notServingSince: CHECKED,
      consecutiveFailures: 2,
      lastFailureAt: null,
    });
  });
});

describe('projectVerdict and the sidecar’s unreachable flag (SUP-517)', () => {
  it('records what the sidecar said, not what the stage implies', () => {
    // A 502 from the bundle route is stage `fetch` with the flag unset: the
    // upstream answered, badly. Inferring unreachability from the stage would
    // report a live ingress as silent (SUP-422 narrows this deliberately).
    const answeredBadly = denied();
    const verdict = {
      ...answeredBadly,
      report: {
        ...answeredBadly.report,
        verified: false,
        stage: 'fetch',
        reason: 'unexpected status 502 from https://partner.example/.well-known/swarm-evidence',
      },
    };

    expect(projectVerdict(endpoint(), verdict, AT).patch.upstreamUnreachable).toBe(false);
  });

  it('records a transport failure as unreachable', () => {
    const failed = denied();
    const verdict = {
      ...failed,
      report: { ...failed.report, verified: false, stage: 'fetch', reason: 'fetch: EOF', unreachable: true },
    };

    expect(projectVerdict(endpoint(), verdict, AT).patch.upstreamUnreachable).toBe(true);
  });

  it('leaves the column alone when the verdict carried no report', () => {
    // Nothing was checked, so "reachable" would be a claim about nothing.
    const row = endpoint({ upstreamUnreachable: true });
    const unchecked = { endpoint: 'upstream-a', health: 'attesting' as const, admitted: false };

    expect(projectVerdict(row, unchecked, AT).patch.upstreamUnreachable).toBe(true);
  });

  it('does not advance the failure counter for a report with no timestamp of its own', () => {
    // `checkedAt` is what tells one check from a re-reading of it. Without it
    // every 5-second poll would look like a fresh failure and `afterFailures: 3`
    // would trip in fifteen seconds — the thing counting distinct checks is for.
    // The Go side emits it unconditionally, so this guards the seam, not a bug.
    const failing = endpoint({
      status: 'denied',
      lastStage: 'policy',
      notServingSince: new Date('2026-10-06T11:49:58.000Z'),
      consecutiveFailures: 1,
    });
    const unstamped = denied();
    const verdict = { ...unstamped, report: { ...unstamped.report, checkedAt: undefined } };

    expect(projectVerdict(failing, verdict, AT).patch.consecutiveFailures).toBe(1);
  });
});

describe('verdictGraceMs', () => {
  it('is twelve polls at the configured interval', () => {
    expect(verdictGraceMs(5_000)).toBe(60_000);
    expect(verdictGraceMs(10_000)).toBe(120_000);
  });

  it('never drops below the floor, so a fast poller cannot flap the catalogue', () => {
    expect(verdictGraceMs(200)).toBe(VERDICT_GRACE_FLOOR_MS);
  });
});

describe('an admission its own check has outlived', () => {
  /** Three `reattestInterval`s at the chart's ten minutes — what production passes. */
  const WINDOW = 30 * 60_000;
  /** `admitted()` carries `checkedAt: 11:59:58`; this is comfortably past the window. */
  const LONG_AFTER = { now: new Date('2026-10-06T12:40:00.000Z'), attestWindowMs: WINDOW };

  it('is not an admission', () => {
    // The wedge the window exists for: `/verdicts` answers on every poll and the
    // `checkedAt` inside it never moves. Nothing about the conversation is wrong,
    // so read recency sees nothing — only the verdict's own timestamp does.
    const { patch, events, statusChanged } = projectVerdict(endpoint({ status: 'verified' }), admitted(), LONG_AFTER);

    expect(statusChanged).toBe(true);
    expect(patch.status).toBe('pending');
    // No stage refused it, the clock did. A stage here would send an operator
    // looking for a refusal that never happened.
    expect(patch.lastStage).toBeNull();
    expect(patch.lastReason).toContain('has not been re-attested since');
    expect(patch.pinnedCertFingerprint).toBeNull();
    expect(events.map((event) => event.kind)).toEqual(['verdict_expired']);
  });

  it('starts the outage clock at the last real check, not at the pass that noticed', () => {
    // This is what lets `outage.afterNoSuccess` run out at all. Dating the run
    // from `now` would restart it on every poll and the alert would never fire.
    const { patch } = projectVerdict(endpoint({ status: 'verified' }), admitted(), LONG_AFTER);

    expect(patch.notServingSince).toEqual(new Date('2026-10-06T11:59:58.000Z'));
    expect(patch.consecutiveFailures).toBe(0);
  });

  it('is withdrawn once: re-reading the same frozen verdict changes nothing', () => {
    // `lastReason` names `checkedAt` and never `now`, so the second pass produces
    // the row the first one wrote — no write, no event, no second warning.
    const first = projectVerdict(endpoint({ status: 'verified' }), admitted(), LONG_AFTER);
    const withdrawn = { ...endpoint({ status: 'verified' }), ...first.patch };

    const second = projectVerdict(withdrawn, admitted(), {
      now: new Date(LONG_AFTER.now.getTime() + 5_000),
      attestWindowMs: WINDOW,
    });

    expect(second.statusChanged).toBe(false);
    expect(second.patchChanged).toBe(false);
    expect(second.events).toEqual([]);
  });

  it('keeps admitting while the verdict is only as old as a re-attestation', () => {
    // `reattestInterval` is ten minutes and the window is three of them, so a
    // verdict a cycle or two behind is the design working, not a fault.
    const { patch } = projectVerdict(endpoint({ status: 'verified' }), admitted(), {
      now: new Date('2026-10-06T12:19:00.000Z'),
      attestWindowMs: WINDOW,
    });

    expect(patch.status).toBe('verified');
  });

  it('leaves a stale denial a denial', () => {
    // A refusal refuses traffic however old it is, and relabelling it `pending`
    // would throw away the stage an operator acts on. Only an admission has to be
    // withdrawn.
    const { patch } = projectVerdict(endpoint({ status: 'verified' }), denied(), LONG_AFTER);

    expect(patch.status).toBe('denied');
    expect(patch.lastStage).toBe('policy');
  });

  it('says nothing about age when the bound is off', () => {
    expect(
      projectVerdict(endpoint({ status: 'verified' }), admitted(), {
        now: LONG_AFTER.now,
        attestWindowMs: 0,
      }).patch.status,
    ).toBe('verified');
  });
});
