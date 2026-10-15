/**
 * The stand helpers whose *behaviour under a lagging verdict* is the thing that
 * matters, exercised without a stand (SUP-329).
 *
 * Both were defects the e2e suite could only show as a flake: a wait that
 * accepted a status whose verdict predated the change the case had just made,
 * and a setup mutation that refused to run twice, so one case's failure killed
 * its siblings' setup. A `ConsoleSession` is an object with a `graphql` function
 * on it, which is all either helper touches — so the lag can be scripted here,
 * deterministically, instead of waited for.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConsoleSession } from './console-client.js';
import {
  addTrustedMeasurement,
  type RegisteredExternalEndpoint,
  STAND_MEASUREMENT,
  trustedMeasurements,
  waitForExternalStatus,
} from './external-stand.js';

/** A session whose `graphql` is whatever the test needs it to be. */
function sessionOf(graphql: ConsoleSession['graphql']): ConsoleSession {
  return {
    cookie: 'session=x',
    workspaceId: 'workspace-1',
    email: 'ops@example.test',
    origin: 'http://localhost',
    graphql,
  };
}

/**
 * A session that answers every operation with `answer`, and records the queries.
 *
 * Hand-rolled rather than `vi.fn`, because `graphql` is generic in its return
 * type and a mock is not: the call site chooses `T`, and a recorded spy would
 * have to be cast at every one of them.
 */
function recording(answer: (query: string) => unknown): { session: ConsoleSession; queries: string[] } {
  const queries: string[] = [];
  const graphql: ConsoleSession['graphql'] = async <T>(query: string): Promise<T> => {
    queries.push(query);
    return answer(query) as T;
  };
  return { session: sessionOf(graphql), queries };
}

/** One `externalEndpoint(id)` answer, defaulting to a verified row with nothing refused. */
function endpoint(overrides: Partial<RegisteredExternalEndpoint> = {}): RegisteredExternalEndpoint {
  return {
    id: 'endpoint-1',
    name: 'partner-cloud',
    status: 'VERIFIED_BY_THIS_ROUTER',
    hostname: 'localhost',
    apiKeyPrefix: 'sk-up',
    measurementSeen: STAND_MEASUREMENT,
    measurementSource: 'REGISTRY',
    evidenceDigestSeen: 'sha256:approved',
    pinnedEvidenceDigest: 'sha256:approved',
    lastStage: null,
    lastReason: null,
    models: [{ id: 'partner/llama', name: 'Llama' }],
    latestEvidence: null,
    pinnedEvidence: null,
    ...overrides,
  };
}

/** Answers `externalEndpoint(id)` with each row in turn, then repeats the last one. */
function readsBack(...rows: RegisteredExternalEndpoint[]): ConsoleSession {
  let index = 0;
  return sessionOf(async <T>() => {
    const row = rows[Math.min(index, rows.length - 1)];
    index += 1;
    return { externalEndpoint: row } as T;
  });
}

describe('waitForExternalStatus', () => {
  it('returns as soon as the status matches, when no evidence is demanded', async () => {
    const session = readsBack(endpoint({ status: 'DENIED_BY_THIS_ROUTER' }));
    const seen = await waitForExternalStatus(session, 'endpoint-1', ['DENIED_BY_THIS_ROUTER']);
    expect(seen.status).toBe('DENIED_BY_THIS_ROUTER');
  });

  it('polls past a denial whose verdict predates the change, and returns the one that carries it', async () => {
    // The flake, scripted: the first denial is the previous beat's — the stand
    // measurement, refused because it had been withdrawn — and the rotation's
    // own verdict is two polls behind it.
    const stale = endpoint({
      status: 'DENIED_BY_THIS_ROUTER',
      lastStage: 'measurement-not-trusted',
      measurementSeen: STAND_MEASUREMENT,
      lastReason: `the measurement ${STAND_MEASUREMENT} is not in attestedRoots.trustedMeasurements`,
    });
    const rotated = endpoint({
      status: 'DENIED_BY_THIS_ROUTER',
      lastStage: 'measurement-not-trusted',
      measurementSeen: 'bb6962eb',
      lastReason: 'the measurement bb6962eb is not in attestedRoots.trustedMeasurements',
    });
    const session = readsBack(stale, stale, rotated);

    const denied = await waitForExternalStatus(session, 'endpoint-1', {
      status: ['DENIED_BY_THIS_ROUTER'],
      measurementSeen: 'bb6962eb',
      reasonContains: 'bb6962eb',
    });
    expect(denied.measurementSeen).toBe('bb6962eb');
  });

  it('holds out for the demanded stage and digest', async () => {
    const wrongStage = endpoint({ status: 'DENIED_BY_THIS_ROUTER', lastStage: 'untrusted-root' });
    const mismatch = endpoint({
      status: 'DENIED_BY_THIS_ROUTER',
      lastStage: 'digest-mismatch',
      evidenceDigestSeen: 'sha256:redeployed',
    });
    const session = readsBack(wrongStage, mismatch);

    const denied = await waitForExternalStatus(session, 'endpoint-1', {
      status: ['DENIED_BY_THIS_ROUTER'],
      stage: 'digest-mismatch',
      evidenceDigestSeen: 'sha256:redeployed',
    });
    expect(denied.evidenceDigestSeen).toBe('sha256:redeployed');
  });

  it('fails loudly, naming what it wanted and what the row last said', async () => {
    vi.useFakeTimers();
    try {
      const session = readsBack(
        endpoint({
          status: 'DENIED_BY_THIS_ROUTER',
          lastStage: 'measurement-not-trusted',
          lastReason: 'the measurement 74c75a0b is not trusted',
        }),
      );
      const waiting = waitForExternalStatus(session, 'endpoint-1', {
        status: ['DENIED_BY_THIS_ROUTER'],
        measurementSeen: 'bb6962eb',
      }).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(31_000);

      const error = await waiting;
      expect(error).toBeInstanceOf(Error);
      // Both halves: a timeout that said only "wanted DENIED" about a row that
      // *was* denied is the message that made this flake unreadable in CI.
      expect((error as Error).message).toContain('having seen measurement bb6962eb');
      expect((error as Error).message).toContain('measurement-not-trusted: the measurement 74c75a0b is not trusted');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('addTrustedMeasurement', () => {
  it('adds the row and returns it', async () => {
    const { session, queries } = recording(() => ({
      addTrustedMeasurement: { id: 'trusted-1', measurement: STAND_MEASUREMENT },
    }));
    const added = await addTrustedMeasurement(session, STAND_MEASUREMENT);
    expect(added).toEqual({ id: 'trusted-1', measurement: STAND_MEASUREMENT });
    // One operation on the happy path: the trust list is only read when the
    // product says the row is already there.
    expect(queries).toHaveLength(1);
  });

  it('answers a repeat with the row already on the list, folding 0x and case', async () => {
    // What a case that failed before its own withdrawal leaves behind: the
    // product refuses the repeat, and the stand resolves it rather than dying in
    // setup and taking its sibling cases with it.
    const session = sessionOf(async <T>(query: string) => {
      if (query.includes('mutation Trust')) {
        throw new Error(`GraphQL: The measurement ${STAND_MEASUREMENT} is already on the trust list.`);
      }
      return {
        trustedMeasurements: [
          { id: 'other', measurement: '0f1e2d3c' },
          { id: 'trusted-1', measurement: STAND_MEASUREMENT },
        ],
      } as T;
    });

    const added = await addTrustedMeasurement(session, `0X${STAND_MEASUREMENT.toUpperCase()}`);
    expect(added).toEqual({ id: 'trusted-1', measurement: STAND_MEASUREMENT });
  });

  it('rethrows the conflict when the measurement is not on the list after all', async () => {
    const session = sessionOf(async <T>(query: string) => {
      if (query.includes('mutation Trust')) {
        throw new Error('GraphQL: The measurement 74c75a0b is already on the trust list.');
      }
      return { trustedMeasurements: [] } as T;
    });
    await expect(addTrustedMeasurement(session, STAND_MEASUREMENT)).rejects.toThrow('already on the trust list');
  });

  it('rethrows anything that is not that conflict', async () => {
    const session = sessionOf(async () => {
      throw new Error('GraphQL: Forbidden resource');
    });
    await expect(addTrustedMeasurement(session, STAND_MEASUREMENT)).rejects.toThrow('Forbidden resource');
  });
});

describe('trustedMeasurements', () => {
  it('reads the list the console reads', async () => {
    const { session, queries } = recording(() => ({ trustedMeasurements: [{ id: 'trusted-1', measurement: 'aa' }] }));
    expect(await trustedMeasurements(session)).toEqual([{ id: 'trusted-1', measurement: 'aa' }]);
    expect(queries).toEqual(['query Trusted { trustedMeasurements { id measurement } }']);
  });
});
