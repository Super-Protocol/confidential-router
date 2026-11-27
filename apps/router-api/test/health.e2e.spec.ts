import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './app-harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('GET /health', () => {
  it('reports the service and its database as healthy', async () => {
    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      database: { status: 'up' },
    });
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  /**
   * The line that keeps the rest of the `mail` block from being read wrong
   * (SUP-462): on an invite-only deployment a `200` from the send route and a
   * healthy `state` are both compatible with nothing having been sent.
   */
  it('says whether sign-up mail can be withheld, and publishes no count that could be', async () => {
    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);

    expect(response.body.mail).toMatchObject({ signUpGate: 'open' });
    expect(response.body.mail).not.toHaveProperty('withheld');
  });

  it('says whether product analytics is configured, without deciding the status', async () => {
    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);

    // No `POSTHOG_PROJECT_KEY` here, which is the point: this is the shape of a
    // deployment whose rebuild forgot the key, and it still answers 200 with
    // `status: 'ok'` because a missing chart is not an outage (SUP-464).
    //
    // `disabled` is the default rather than a derivation: the harness replaces
    // `ANALYTICS_SINK` wholesale, so `createAnalyticsSink` never runs here. What
    // this asserts is the wiring — the field is served, and it is served without
    // touching the overall status. That `disabled` follows from a missing key is
    // `analytics.module.spec.ts`'s job.
    expect(response.body).toMatchObject({ status: 'ok', analytics: { status: 'disabled', dropped: 0 } });
  });

  it('reports analytics without naming the project or the host', async () => {
    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);

    // `/health` is unauthenticated: `configured`/`disabled` and a count, nothing
    // that describes the key or where events go. `admin-health.e2e.spec.ts` owns
    // the operator's copy of the same document (SUP-479).
    expect(Object.keys(response.body.analytics).sort()).toEqual(['dropped', 'status']);
  });

  it('answers whether the registered external upstreams are serving', async () => {
    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);

    // Nothing registered in the harness, so `none` — and that is the assertion
    // worth making here: the field is served, and `none` is distinct from `ok`.
    // Whether a dark upstream reads `outage` is `external-endpoint-status.service.spec.ts`'s job.
    expect(response.body).toMatchObject({
      status: 'ok',
      externalEndpoints: {
        status: 'none',
        registered: 0,
        serving: 0,
        routable: 0,
        failing: 0,
        unreachable: 0,
        pending: 0,
        // Nothing registered at all, so `none` is the honest answer rather than
        // the one a dark deployment used to hide behind (SUP-879).
        disabled: 0,
        awaitingKey: 0,
        models: 0,
        routableModels: 0,
      },
    });
  });

  it('reports the upstreams without naming one', async () => {
    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);

    // `/health` is public and unauthenticated. Ruling 3 on SUP-221 keeps upstream
    // identity and verdict detail behind a session, so this block is counts, two
    // optional timestamps and a word — never a name, hostname, stage or reason.
    expect(Object.keys(response.body.externalEndpoints).sort()).toEqual([
      'awaitingKey',
      'disabled',
      'failing',
      'models',
      'pending',
      'registered',
      'routable',
      'routableModels',
      'serving',
      'status',
      'unreachable',
    ]);
  });

  it('says whether the evidence retention sweep is running, without deciding the status', async () => {
    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);

    // `disabled` because the harness switches the timer off (fixtures carry
    // fixed dates), which is also the shape of a deployment that set
    // `evidence.retentionSweepInterval` to 0 — publishing a retention period it
    // does not keep, and still serving every model, so still `ok` (SUP-498).
    expect(response.body).toMatchObject({
      status: 'ok',
      evidenceRetention: { status: 'disabled', lastSweepAt: null, stripped: 0, failed: 0 },
    });
  });

  it('echoes the request id back so a client can correlate a failure', async () => {
    const response = await request(harness.app.getHttpServer())
      .get('/health')
      .set('x-request-id', 'test-request-id')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('test-request-id');
  });

  it('generates a request id when the client does not send one', async () => {
    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets the security headers Helmet is there for', async () => {
    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('GET /health with the retention sweep on', () => {
  let swept: Harness;

  beforeAll(async () => {
    // The field is only worth anything if it moves. The sweep runs its first
    // pass on the tick after bootstrap, so this asserts the wiring an operator
    // actually reads: a timer exists, a pass finished, and the count is there.
    swept = await createHarness({ env: { CR_API_EVIDENCE__RETENTION_SWEEP_INTERVAL: '6h' } });
  }, 60_000);

  afterAll(async () => {
    await swept?.close();
  });

  it('reports the sweep as enabled', async () => {
    const response = await request(swept.app.getHttpServer()).get('/health').expect(200);

    expect(response.body.evidenceRetention).toMatchObject({ status: 'enabled', stripped: 0, failed: 0 });
  });

  it('fills in `lastSweepAt` once the first pass has finished', async () => {
    // Polled rather than read once: the first pass is started on the tick after
    // bootstrap and deliberately not awaited there, so boot never waits on a
    // table scan.
    await expect
      .poll(async () => (await request(swept.app.getHttpServer()).get('/health')).body.evidenceRetention.lastSweepAt, {
        timeout: 5_000,
      })
      .toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('CORS', () => {
  it('allows an origin on the allowlist', async () => {
    const response = await request(harness.app.getHttpServer())
      .get('/health')
      .set('Origin', 'http://localhost:4200')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('refuses an origin that is not', async () => {
    const response = await request(harness.app.getHttpServer()).get('/health').set('Origin', 'https://evil.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('unknown routes', () => {
  it('404s', async () => {
    await request(harness.app.getHttpServer()).get('/does-not-exist').expect(404);
  });
});
