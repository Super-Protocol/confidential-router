import { describe, expect, it } from 'vitest';
import { ExternalEndpointHealth } from './external-endpoint-health.js';
import type { CatalogueDarkness, CatalogueReach, EndpointLiveness } from './external-endpoint-liveness.js';

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

/** What a pass publishes about the catalogue, with one upstream's worth of models. */
function reach(routable: number, overrides: Partial<CatalogueReach> = {}): CatalogueReach {
  return {
    routable,
    models: 1,
    routableModels: routable,
    disabled: 0,
    awaitingKey: 0,
    darkness: { dark: false, since: null, outage: false },
    ...overrides,
  };
}

/** A deployment holding a model it routes to nothing, as `darknessOf` reports it. */
function dark(since: Date, outage: boolean): CatalogueDarkness {
  return { dark: true, since, outage };
}

describe('ExternalEndpointHealth', () => {
  it('answers none before anything has been published', () => {
    // A process that has not reached the first reset yet. `none` with a zero
    // count is the only honest answer; it is not `ok`.
    expect(new ExternalEndpointHealth().status()).toMatchObject({ status: 'none', registered: 0 });
  });

  it('reports the count from the rows and the timestamp from the sidecar read', () => {
    const health = new ExternalEndpointHealth();
    health.report([serving('a')], READ, reach(1));

    expect(health.status()).toMatchObject({
      status: 'ok',
      registered: 1,
      serving: 1,
      routable: 1,
      verdictsReadAt: READ.toISOString(),
    });
  });

  it('calls it an outage when the rows admit and the catalogue will not route', () => {
    // SUP-600. The row said `verified` and this process's catalogue was empty,
    // so `/v1/models` answered `[]` and every completion was a 503 while this
    // document said `status: ok, serving: 1`. The cause is fixed; the comparison
    // stays, because the two readers disagreeing has to be visible — and one
    // word, not two numbers — in the document an operator opens during an outage.
    const health = new ExternalEndpointHealth();
    health.report([serving('a')], READ, reach(0));
    health.report([serving('a')], READ, reach(0));

    expect(health.status()).toMatchObject({ status: 'outage', serving: 1, routable: 0 });
  });

  it('does not call one disagreeing pass an outage', () => {
    // A pass reads the rows at its start and rebuilds the catalogue at its end,
    // so the pod booting beside this one — which resets every row to `pending`
    // on every rolling update — makes a single pass disagree with nothing wrong.
    // Reporting that as `outage` would fire on exactly the window an operator
    // watches `routable == serving` to confirm this fix worked.
    const health = new ExternalEndpointHealth();
    health.report([serving('a')], READ, reach(1));

    health.report([serving('a')], READ, reach(0));
    expect(health.status()).toMatchObject({ status: 'ok', serving: 1, routable: 0 });

    // …and the next pass finds the two agreeing again, so nothing was ever said.
    health.report([serving('a')], READ, reach(1));
    expect(health.status()).toMatchObject({ status: 'ok', serving: 1, routable: 1 });
  });

  it('keeps the last read timestamp when a pass could not reach the sidecar', () => {
    // The shape of "this router is no longer being told anything": the counts
    // stay true to the last projection while the timestamp stops moving. Clearing
    // it would answer "when did we last hear from the sidecar" with "never",
    // which is false and strictly less useful.
    const health = new ExternalEndpointHealth();
    health.report([serving('a')], READ, reach(1));

    health.report([serving('a')], null, reach(1));

    expect(health.status().verdictsReadAt).toBe(READ.toISOString());
  });

  it('publishes the switched-off rows no liveness can carry', () => {
    // SUP-879. Every endpoint is off, so `livenesses` is empty and `registered`
    // is 0 — and this document used to stop there, reporting `none` for a
    // deployment that advertises a model and serves nothing.
    const health = new ExternalEndpointHealth();
    health.report([], READ, reach(0, { disabled: 1, awaitingKey: 1, darkness: dark(READ, true) }));

    expect(health.status()).toMatchObject({
      status: 'outage',
      registered: 0,
      disabled: 1,
      awaitingKey: 1,
      models: 1,
      routableModels: 0,
    });
  });
});
