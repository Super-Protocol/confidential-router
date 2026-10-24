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
    health.report([serving('a')], READ);

    expect(health.status()).toMatchObject({
      status: 'ok',
      registered: 1,
      serving: 1,
      verdictsReadAt: READ.toISOString(),
    });
  });

  it('keeps the last read timestamp when a pass could not reach the sidecar', () => {
    // The shape of "this router is no longer being told anything": the counts
    // stay true to the last projection while the timestamp stops moving. Clearing
    // it would answer "when did we last hear from the sidecar" with "never",
    // which is false and strictly less useful.
    const health = new ExternalEndpointHealth();
    health.report([serving('a')], READ);

    health.report([serving('a')], null);

    expect(health.status().verdictsReadAt).toBe(READ.toISOString());
  });
});
