import { describe, expect, it } from 'vitest';
import { ExternalEndpointHealth } from './external-endpoint-health.js';
import type { EndpointLiveness } from './external-endpoint-liveness.js';

const READ = new Date('2026-10-24T12:00:00.000Z');

function serving(name: string): EndpointLiveness {
  return {
    name,
    status: 'verified',
    reachability: 'reachable',
    stage: null,
    reason: null,
    consecutiveFailures: 0,
    notServingSince: null,
    lastSuccessAt: READ,
    lastCheckedAt: READ,
    outage: false,
  };
}

describe('ExternalEndpointHealth', () => {
  it('answers none before anything has been published', () => {
    // A process that has not reached the first reset yet. `none` with a zero
    // count is the only honest answer; it is not `ok`.
    expect(new ExternalEndpointHealth().status()).toMatchObject({ status: 'none', registered: 0 });
  });

  it('reports the count from the rows and the timestamp from the sidecar read', () => {
    const health = new ExternalEndpointHealth();
    health.report([serving('a')], READ, 1);

    expect(health.status()).toMatchObject({
      status: 'ok',
      registered: 1,
      serving: 1,
      verdictsReadAt: READ.toISOString(),
    });
  });

  it('reports the catalogue beside the rows, so a dark /v1 cannot read as serving', () => {
    // SUP-600. The row said `verified` and this process's catalogue was empty,
    // so `/v1/models` answered `[]` and every completion was a 503 while this
    // document said `serving: 1`. The cause is fixed; the count stays, because
    // the two readers disagreeing has to be visible in the document an operator
    // opens during an outage.
    const health = new ExternalEndpointHealth();
    health.report([serving('a')], READ, 0);

    expect(health.status()).toMatchObject({ status: 'ok', serving: 1, routableModels: 0 });
  });

  it('keeps the last read timestamp when a pass could not reach the sidecar', () => {
    // The shape of "this router is no longer being told anything": the counts
    // stay true to the last projection while the timestamp stops moving. Clearing
    // it would answer "when did we last hear from the sidecar" with "never",
    // which is false and strictly less useful.
    const health = new ExternalEndpointHealth();
    health.report([serving('a')], READ, 1);

    health.report([serving('a')], null, 1);

    expect(health.status().verdictsReadAt).toBe(READ.toISOString());
  });
});
