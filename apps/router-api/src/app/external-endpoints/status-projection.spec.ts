import { describe, expect, it } from 'vitest';
import type { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import type { SidecarVerdict } from './sidecar-admin.client.js';
import { projectVerdict, statusOf } from './status-projection.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
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
    evidenceDigestSeen: null,
    pinnedCertFingerprint: null,
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

describe('projectVerdict', () => {
  it('writes the observed measurement, digest and pinned leaf on an admission', () => {
    const { patch } = projectVerdict(endpoint(), admitted(), NOW);

    expect(patch).toEqual({
      status: 'verified',
      lastCheckedAt: new Date('2026-10-06T11:59:58.000Z'),
      lastStage: null,
      lastReason: null,
      measurementSeen: MEASUREMENT,
      measurementSource: 'operator-pinned',
      evidenceDigestSeen: DIGEST,
      pinnedCertFingerprint: FINGERPRINT,
    });
  });

  it('records the stage and reason of a denial, and pins nothing', () => {
    // A fingerprint left over from an earlier admission would read as "this is
    // what we are pinned to" about an endpoint that is refusing traffic.
    const { patch } = projectVerdict(
      endpoint({ status: 'verified', pinnedCertFingerprint: FINGERPRINT }),
      denied(),
      NOW,
    );

    expect(patch.status).toBe('denied');
    expect(patch.lastStage).toBe('policy');
    expect(patch.lastReason).toContain('denied');
    expect(patch.pinnedCertFingerprint).toBeNull();
  });

  it('falls back to now when the report carries no timestamp', () => {
    const { patch } = projectVerdict(endpoint(), admitted({ report: { admitted: true } }), NOW);

    expect(patch.lastCheckedAt).toEqual(NOW);
  });

  it('claims no check at all while the sidecar is still attesting', () => {
    // A row with no report has not been checked, so `lastCheckedAt` has to stay
    // where it was. Writing `now` would claim a check that never ran — and, since
    // `now` advances, would make every five-second poll of an attesting endpoint
    // look like a change worth an `UPDATE`.
    const attesting: SidecarVerdict = { endpoint: 'upstream-a', health: 'attesting', admitted: false };

    const fresh = projectVerdict(endpoint(), attesting, NOW);
    expect(fresh.patch.lastCheckedAt).toBeNull();
    expect(fresh.patchChanged).toBe(false);

    const previously = new Date('2026-10-06T11:00:00.000Z');
    const seen = projectVerdict(endpoint({ lastCheckedAt: previously }), attesting, NOW);
    expect(seen.patch.lastCheckedAt).toEqual(previously);
  });

  it('clips a reason to the column rather than letting an insert fail', () => {
    const long = 'x'.repeat(400);
    const { patch } = projectVerdict(endpoint(), denied({ reason: long }), NOW);

    expect(patch.lastReason).toHaveLength(255);
    expect(patch.lastReason?.endsWith('…')).toBe(true);
  });

  it('writes one event on a flip, and reports the flip', () => {
    const verified = projectVerdict(endpoint(), admitted(), NOW);
    expect(verified.statusChanged).toBe(true);
    expect(verified.events.map((event) => event.kind)).toEqual(['verified']);

    const refused = projectVerdict(endpoint({ status: 'verified' }), denied(), NOW);
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
      evidenceDigestSeen: DIGEST,
      pinnedCertFingerprint: FINGERPRINT,
    });

    expect(projectVerdict(unchanged, admitted(), NOW).patchChanged).toBe(false);
  });

  it('compares a timestamp by its instant, not by object identity', () => {
    // `lastCheckedAt` comes back from the driver as a fresh `Date` every read, so
    // an identity comparison would call every poll a change and defeat the check.
    const row = endpoint({ status: 'pending', lastCheckedAt: new Date('2026-10-06T11:59:58.000Z') });

    const { patch, patchChanged } = projectVerdict(row, admitted(), NOW);

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
      evidenceDigestSeen: DIGEST,
      pinnedCertFingerprint: FINGERPRINT,
    });

    expect(projectVerdict(row, admitted(), NOW).patchChanged).toBe(true);
  });

  it('writes no event when the verdict only repeats itself', () => {
    // At a ten-minute TTL a stable endpoint re-attests 144 times a day, and a row
    // per check would bury the changes an operator is looking for.
    const { events, statusChanged } = projectVerdict(
      endpoint({ status: 'verified', measurementSeen: MEASUREMENT, evidenceDigestSeen: DIGEST }),
      admitted(),
      NOW,
    );

    expect(statusChanged).toBe(false);
    expect(events).toEqual([]);
  });

  it('reports a digest change even while the endpoint stays verified', () => {
    // The same trusted cloud redeploying a different image: cloud-granularity
    // trust (threat T13) is exactly why this cannot be left implicit.
    const { events, statusChanged } = projectVerdict(
      endpoint({ status: 'verified', measurementSeen: MEASUREMENT, evidenceDigestSeen: OTHER_DIGEST }),
      admitted(),
      NOW,
    );

    expect(statusChanged).toBe(false);
    expect(events.map((event) => event.kind)).toEqual(['digest_changed']);
    expect(events[0].evidenceDigest).toBe(DIGEST);
  });

  it('reports a measurement change', () => {
    const { events } = projectVerdict(
      endpoint({ status: 'verified', measurementSeen: OTHER_MEASUREMENT, evidenceDigestSeen: DIGEST }),
      admitted(),
      NOW,
    );

    expect(events.map((event) => event.kind)).toEqual(['measurement_changed']);
  });

  it('does not call the first observation a change', () => {
    // A fresh row has seen nothing; calling that a `digest_changed` would put a
    // change in the timeline of every endpoint ever registered.
    const { events } = projectVerdict(endpoint(), admitted(), NOW);

    expect(events.map((event) => event.kind)).toEqual(['verified']);
  });

  it('never writes an event for a flip back to pending', () => {
    // Only this process restarted, which is not news about the upstream.
    const { events, patch } = projectVerdict(endpoint({ status: 'verified' }), {
      endpoint: 'upstream-a',
      health: 'attesting',
      admitted: false,
    });

    expect(patch.status).toBe('pending');
    expect(events).toEqual([]);
  });
});
