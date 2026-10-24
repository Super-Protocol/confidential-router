/**
 * The two control-plane helpers SUP-528 added, against a stubbed console session.
 *
 * Both exist so that one flaky assertion in
 * `apps/router-api-e2e/src/external-endpoints.e2e.spec.ts` reports as one
 * failure instead of three, and both are easy to get subtly wrong in a way no
 * e2e run would name: a withdrawal that throws when there is nothing to
 * withdraw is useless in an `afterEach`, and a `since` that is not actually
 * consulted leaves the race it was added for exactly where it was.
 */
import { describe, expect, it } from 'vitest';
import type { ConsoleSession } from './console-client.js';
import {
  type RegisteredExternalEndpoint,
  STAND_MEASUREMENT,
  waitForExternal,
  withdrawTrustedMeasurement,
} from './external-stand.js';

const OTHER_MEASUREMENT = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const VERIFIED = 'VERIFIED_BY_THIS_ROUTER';

interface StubCall {
  operation: string;
  variables: Record<string, unknown>;
}

/**
 * A `ConsoleSession` that answers from `handlers`, keyed by the operation name
 * in the document — which is what makes an unstubbed call a failure rather than
 * an empty answer the assertion then reads as success.
 */
function stubSession(handlers: Record<string, (variables: Record<string, unknown>) => unknown>): {
  session: ConsoleSession;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const session: ConsoleSession = {
    cookie: 'cr_session=stub',
    workspaceId: 'ws-1',
    email: 'ops@example.test',
    origin: 'http://localhost',
    async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? query;
      calls.push({ operation, variables });
      const handler = handlers[operation];
      if (!handler) {
        throw new Error(`the stub has no answer for ${operation}`);
      }
      return handler(variables) as T;
    },
  };
  return { session, calls };
}

const ENDPOINT: RegisteredExternalEndpoint = {
  id: 'ep-1',
  name: 'partner-cloud',
  status: VERIFIED,
  hostname: 'localhost',
  apiKeyPrefix: 'sk-upst',
  lastCheckedAt: null,
  measurementSeen: STAND_MEASUREMENT,
  measurementSource: 'REGISTRY',
  evidenceDigestSeen: 'sha256:aaa',
  pinnedEvidenceDigest: 'sha256:aaa',
  lastStage: null,
  lastReason: null,
  models: [],
  latestEvidence: null,
  pinnedEvidence: null,
};

describe('withdrawTrustedMeasurement', () => {
  it('finds the row by its value and withdraws that one', async () => {
    const { session, calls } = stubSession({
      TrustList: () => ({
        trustedMeasurements: [
          { id: 'tm-1', measurement: OTHER_MEASUREMENT, note: 'another cloud, not this one' },
          { id: 'tm-2', measurement: STAND_MEASUREMENT, note: 'the stand upstream cloud' },
        ],
      }),
      Withdraw: () => ({ removeTrustedMeasurement: true }),
    });

    expect(await withdrawTrustedMeasurement(session, STAND_MEASUREMENT)).toBe(true);
    expect(calls.at(-1)).toEqual({ operation: 'Withdraw', variables: { id: 'tm-2' } });
  });

  /**
   * The property that makes it safe in an `afterEach`: a case that reached its
   * own cleanup must not have the hook fail behind it with "Trusted measurement
   * not found", which is what the id-taking mutation answers.
   */
  it('reports false and mutates nothing when the measurement is not listed', async () => {
    const { session, calls } = stubSession({ TrustList: () => ({ trustedMeasurements: [] }) });

    expect(await withdrawTrustedMeasurement(session, STAND_MEASUREMENT)).toBe(false);
    expect(calls.map((call) => call.operation)).toEqual(['TrustList']);
  });

  // The admin API normalises a measurement on input, so the list holds the
  // normalised form and a lookup of what the operator typed has to match it.
  it('matches the normalised value, whatever form it was given in', async () => {
    const { session, calls } = stubSession({
      TrustList: () => ({ trustedMeasurements: [{ id: 'tm-2', measurement: STAND_MEASUREMENT, note: null }] }),
      Withdraw: () => ({ removeTrustedMeasurement: true }),
    });

    expect(await withdrawTrustedMeasurement(session, `0x${STAND_MEASUREMENT.toUpperCase()}`)).toBe(true);
    expect(calls.at(-1)?.variables).toEqual({ id: 'tm-2' });
  });
});

describe('waitForExternal with `since`', () => {
  /**
   * The guard itself: the stale row satisfies `until` on the first read and is
   * refused anyway, because the check it projects predates the change being
   * waited on. Without it the wait returns on read 1 — the previous case's
   * verdict, read as this one's — which is the race that took two unrelated
   * PRs red (SUP-528).
   */
  it('discards a verdict older than `since` and resolves on the next one', async () => {
    const since = Date.now();
    const stale = { ...ENDPOINT, lastCheckedAt: new Date(since - 2_000).toISOString() };
    const fresh = { ...ENDPOINT, lastCheckedAt: new Date(since + 1_000).toISOString() };
    let reads = 0;
    const { session } = stubSession({
      External: () => {
        reads += 1;
        return { externalEndpoint: reads < 3 ? stale : fresh };
      },
    });

    const seen = await waitForExternal(session, 'ep-1', {
      since,
      until: (endpoint) => endpoint.status === VERIFIED,
      wanted: 'a check after the trust-list edit that admits it',
    });

    expect(reads).toBe(3);
    expect(seen.lastCheckedAt).toBe(fresh.lastCheckedAt);
  });

  // A check at the same millisecond as `since` counts: `lastCheckedAt` arrives
  // truncated to milliseconds, and refusing it would make the guard reject the
  // very verdict it is waiting for.
  it('accepts a check at the same instant as `since`', async () => {
    const since = Date.now();
    const { session, calls } = stubSession({
      External: () => ({ externalEndpoint: { ...ENDPOINT, lastCheckedAt: new Date(since).toISOString() } }),
    });

    await waitForExternal(session, 'ep-1', { since, until: () => true, wanted: 'anything' });
    expect(calls).toHaveLength(1);
  });

  // Without `since` the wait reads the row as it stands — what the registration
  // beats want, where the status only ever moves one way.
  it('answers from the row as it stands when no `since` is given', async () => {
    const { session, calls } = stubSession({
      External: () => ({ externalEndpoint: { ...ENDPOINT, lastCheckedAt: new Date(0).toISOString() } }),
    });

    const seen = await waitForExternal(session, 'ep-1', {
      until: (endpoint) => endpoint.status === VERIFIED,
      wanted: 'verified',
    });

    expect(seen.status).toBe(VERIFIED);
    expect(calls).toHaveLength(1);
  });
});
