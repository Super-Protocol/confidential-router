import { describe, expect, it } from 'vitest';
import type { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import {
  durationSince,
  expectedToServe,
  isOutage,
  type LivenessRow,
  livenessOf,
  type OutageThresholds,
  outageLine,
  reachabilityOf,
  summarise,
} from './external-endpoint-liveness.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const DIGEST = 'sha256/BvG0Yy3Ir0QKPtC1TrSPuyZZD1sdKq7Gq_a1Mv1Hs0A';

/** Production's defaults, so the thresholds under test are the ones that ship. */
const THRESHOLDS: OutageThresholds = { afterFailures: 3, afterNoSuccess: 15 * 60_000 };

function row(overrides: Partial<LivenessRow> = {}): LivenessRow {
  return {
    name: 'upstream-a',
    enabled: true,
    status: 'verified',
    lastStage: null,
    lastReason: null,
    lastCheckedAt: NOW,
    lastSuccessAt: NOW,
    notServingSince: null,
    consecutiveFailures: 0,
    pinnedEvidenceDigest: DIGEST,
    ...overrides,
  } as ExternalEndpoint;
}

/** The incident this exists for: the gateway dropped the route, the fetch got EOF. */
function dark(overrides: Partial<LivenessRow> = {}): LivenessRow {
  return row({
    status: 'denied',
    lastStage: 'fetch',
    lastReason: 'fetch: EOF',
    notServingSince: new Date(NOW.getTime() - 31 * 60_000),
    lastSuccessAt: new Date(NOW.getTime() - 31 * 60_000),
    consecutiveFailures: 3,
    ...overrides,
  });
}

describe('reachabilityOf', () => {
  it('calls a fetch failure unreachable — the upstream never spoke', () => {
    expect(reachabilityOf(dark())).toBe('unreachable');
  });

  it('calls every other refusal reachable, because something answered to be refused', () => {
    // The distinction the outage turned on: a digest nobody approved and a
    // hostname that stopped resolving rendered identically before this.
    for (const stage of ['cert-chain', 'untrusted-root', 'jws', 'tls-fingerprint', 'policy', 'digest-mismatch']) {
      expect(reachabilityOf(row({ status: 'denied', lastStage: stage }))).toBe('reachable');
    }
  });

  it('is unknown before the first check, not reachable and not down', () => {
    expect(reachabilityOf(row({ status: 'pending', lastCheckedAt: null }))).toBe('unknown');
  });

  it('is reachable on an admission whatever the stale stage says', () => {
    expect(reachabilityOf(row({ status: 'verified', lastStage: 'fetch' }))).toBe('reachable');
  });
});

describe('expectedToServe', () => {
  it('exempts an endpoint an operator switched off', () => {
    expect(expectedToServe(dark({ enabled: false }))).toBe(false);
  });

  it('exempts one whose deployment has never been approved', () => {
    // A registration awaiting its first `pinExternalEndpointDigest` is `pending`
    // with `digest-not-pinned` by design (SUP-252). Paging for it would have
    // meant paging once for every endpoint the two-factor upgrade touched.
    expect(expectedToServe(dark({ pinnedEvidenceDigest: null }))).toBe(false);
  });

  it('does not exempt one whose pin stopped matching', () => {
    // An unapproved redeploy. A pin exists, so this router was serving the
    // upstream a moment ago and is not now — an outage, whoever caused it.
    expect(expectedToServe(dark({ lastStage: 'digest-mismatch' }))).toBe(true);
  });
});

describe('isOutage', () => {
  it('is false while an endpoint is serving', () => {
    expect(isOutage(row(), THRESHOLDS, NOW)).toBe(false);
  });

  it('is false for a single failed check — one bad fetch is noise', () => {
    const once = dark({ consecutiveFailures: 1, notServingSince: new Date(NOW.getTime() - 60_000) });
    expect(isOutage(once, THRESHOLDS, NOW)).toBe(false);
  });

  it('trips on the configured run of failures', () => {
    const run = dark({ consecutiveFailures: 3, notServingSince: new Date(NOW.getTime() - 60_000) });
    expect(isOutage(run, THRESHOLDS, NOW)).toBe(true);
    expect(isOutage({ ...run, consecutiveFailures: 2 }, THRESHOLDS, NOW)).toBe(false);
  });

  it('trips on elapsed time even when nothing has been checked at all', () => {
    // The failure a counter cannot see: a sidecar that never answers leaves every
    // row at `pending` and increments nothing. Thirty hours of 503s looked exactly
    // like this from the counter's point of view.
    const silent = row({
      status: 'pending',
      lastCheckedAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      notServingSince: new Date(NOW.getTime() - 16 * 60_000),
    });

    expect(isOutage(silent, THRESHOLDS, NOW)).toBe(true);
    expect(isOutage({ ...silent, notServingSince: new Date(NOW.getTime() - 60_000) }, THRESHOLDS, NOW)).toBe(false);
  });

  it('honours a disabled threshold, each on its own', () => {
    const run = dark({ consecutiveFailures: 9, notServingSince: new Date(NOW.getTime() - 60_000) });
    expect(isOutage(run, { afterFailures: 0, afterNoSuccess: 15 * 60_000 }, NOW)).toBe(false);

    const long = dark({ consecutiveFailures: 0, notServingSince: new Date(NOW.getTime() - 48 * 3_600_000) });
    expect(isOutage(long, { afterFailures: 3, afterNoSuccess: 0 }, NOW)).toBe(false);
    expect(isOutage(long, { afterFailures: 0, afterNoSuccess: 0 }, NOW)).toBe(false);
  });
});

describe('summarise', () => {
  const read = new Date(NOW.getTime() - 5_000);

  it('says none when nothing is registered, so there is nothing to be wrong', () => {
    expect(summarise([], null)).toMatchObject({ status: 'none', registered: 0 });
  });

  it('says unknown while no verdict has been read back', () => {
    const liveness = livenessOf(row({ status: 'pending', lastCheckedAt: null }), THRESHOLDS, NOW);
    expect(summarise([liveness], null).status).toBe('unknown');
  });

  it('says ok only when every enabled upstream is serving', () => {
    expect(summarise([livenessOf(row(), THRESHOLDS, NOW)], read)).toMatchObject({
      status: 'ok',
      registered: 1,
      serving: 1,
      failing: 0,
      unreachable: 0,
      pending: 0,
      verdictsReadAt: read.toISOString(),
    });
  });

  it('says degraded for a refusal below the thresholds, and names no endpoint', () => {
    const fresh = dark({ consecutiveFailures: 1, notServingSince: new Date(NOW.getTime() - 60_000) });
    const summary = summarise([livenessOf(fresh, THRESHOLDS, NOW)], read);

    expect(summary).toMatchObject({ status: 'degraded', failing: 1, unreachable: 1, serving: 0 });
    // Public and unauthenticated: counts, never identity (SUP-221 ruling 3).
    expect(JSON.stringify(summary)).not.toContain('upstream-a');
  });

  it('says outage once a run has crossed a threshold, with the oldest start', () => {
    const summary = summarise([livenessOf(dark(), THRESHOLDS, NOW), livenessOf(row(), THRESHOLDS, NOW)], read);

    expect(summary).toMatchObject({
      status: 'outage',
      registered: 2,
      serving: 1,
      failing: 1,
      since: new Date(NOW.getTime() - 31 * 60_000).toISOString(),
    });
  });

  it('answers outage even with no verdict ever read, rather than hiding behind unknown', () => {
    const silent = row({
      status: 'pending',
      lastCheckedAt: null,
      lastSuccessAt: null,
      notServingSince: new Date(NOW.getTime() - 16 * 60_000),
    });

    expect(summarise([livenessOf(silent, THRESHOLDS, NOW)], null).status).toBe('outage');
  });
});

describe('outageLine', () => {
  it('carries everything needed to act without opening a console', () => {
    const line = outageLine(livenessOf(dark(), THRESHOLDS, NOW), NOW);

    expect(line).toContain('"upstream-a"');
    expect(line).toContain('31m');
    expect(line).toContain('3 consecutive failed check(s)');
    expect(line).toContain('the upstream did not answer');
    expect(line).toContain('stage fetch');
    expect(line).toContain('fetch: EOF');
    expect(line).toContain('503 attestation_failed');
  });
});

describe('durationSince', () => {
  it('is coarse on purpose: minutes, then hours, then days', () => {
    expect(durationSince(new Date(NOW.getTime() - 31 * 60_000), NOW)).toBe('31m');
    expect(durationSince(new Date(NOW.getTime() - 90 * 60_000), NOW)).toBe('1h30m');
    // The number that made the point: the outage this comes from ran 30 hours.
    expect(durationSince(new Date(NOW.getTime() - 30 * 3_600_000), NOW)).toBe('30h00m');
    expect(durationSince(new Date(NOW.getTime() - 72 * 3_600_000), NOW)).toBe('3d');
  });

  it('refuses to invent a start it does not have', () => {
    expect(durationSince(null, NOW)).toBe('an unknown period');
  });
});
