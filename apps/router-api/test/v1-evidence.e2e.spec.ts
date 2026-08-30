import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Endpoint } from '../src/app/db/entities/endpoint.entity.js';
import { EvidenceSnapshot } from '../src/app/db/entities/evidence-snapshot.entity.js';
import { Generation } from '../src/app/db/entities/generation.entity.js';
import { createHarness, type Harness } from './app-harness.js';
import { bearer, createKey, routerConfigFor, seedWorkspace } from './gateway-fixture.js';
import { MockLiteLlm } from './mock-litellm.js';

/**
 * "Evidence coverage" is the one thing the router is allowed to say about
 * attestation: was the endpoint publishing a bundle when the request went
 * through (ADR-002). Never whether it verified — that happens in the user's
 * gatekeeper and the router never learns the answer.
 *
 * Each case uses its own endpoint so one harness covers all three: coverage is
 * resolved per endpoint and briefly cached.
 */

const upstream = new MockLiteLlm();
const COVERED_DIGEST = 'sha256/6b1fbeef00000000000000000000000000000000000=';

let harness: Harness;
let secret: string;

beforeAll(async () => {
  const baseUrl = await upstream.start();
  harness = await createHarness({ config: routerConfigFor(baseUrl, { evidence: { freshnessWindow: '24h' } }) });
  const workspace = await seedWorkspace(harness.app);
  secret = (await createKey(harness.app, workspace.id)).secret;

  await publish('mock-covered', COVERED_DIGEST, new Date());
  // Two days old against a 24-hour freshness window.
  await publish('mock-stale', 'sha256/staaale', new Date(Date.now() - 48 * 3_600_000));
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await upstream.stop();
});

async function publish(endpointName: string, evidenceDigest: string, issuedAt: Date): Promise<void> {
  const dataSource = harness.app.get(DataSource);
  const endpoint = await dataSource.getRepository(Endpoint).findOneByOrFail({ name: endpointName });
  await dataSource.getRepository(EvidenceSnapshot).save({
    id: randomUUID(),
    endpointId: endpoint.id,
    fetchedAt: issuedAt,
    issuedAt,
    evidenceDigest,
    evidenceDigestHex: '6b1f',
    certFingerprint: 'sha256/cert',
    quoteFormat: 'intel-tdx-quote-v5',
    containerImages: ['ghcr.io/example/router@sha256:abc'],
    chainSummary: [],
    measurements: null,
    jws: 'eyJ.payload.sig',
    bundle: { kind: 'deployment' },
  });
}

async function complete(model: string) {
  return request(harness.app.getHttpServer())
    .post('/v1/chat/completions')
    .set(bearer(secret))
    .send({ model, messages: [{ role: 'user', content: 'Hello there' }] })
    .expect(200);
}

describe('evidence coverage', () => {
  it('reports the digest the platform had published for the endpoint', async () => {
    const response = await complete('mock/covered:tdx');

    expect(response.body.usage.evidence_digest).toBe(COVERED_DIGEST);

    const row = await harness.app.get(DataSource).getRepository(Generation).findOneByOrFail({ id: response.body.id });
    expect(row.evidenceDigest).toBe(COVERED_DIGEST);
    expect(row.evidenceSnapshotId).not.toBeNull();
  });

  it('treats a snapshot older than the freshness window as no coverage', async () => {
    const response = await complete('mock/stale:tdx');

    expect(response.body.usage.evidence_digest).toBeNull();

    const row = await harness.app.get(DataSource).getRepository(Generation).findOneByOrFail({ id: response.body.id });
    expect(row.evidenceSnapshotId).toBeNull();
  });

  it('reports no coverage for an endpoint that has published nothing', async () => {
    const response = await complete('mock/chat:tdx');

    expect(response.body.usage.evidence_digest).toBeNull();
  });

  it('never turns coverage into a verdict', async () => {
    const response = await complete('mock/covered:tdx');

    expect(JSON.stringify(response.body)).not.toMatch(/verified|attested|trusted|valid/i);
  });
});
