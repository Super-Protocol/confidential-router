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
