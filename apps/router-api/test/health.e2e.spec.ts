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
