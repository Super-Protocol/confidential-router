/**
 * The relay the chat's tier-1 gate verifies through (SUP-191).
 *
 * The property under test is narrow and the whole point: **this router hands
 * back the document it stored, unchanged.** The browser checks a JWS over that
 * document's own bytes, so anything this layer rewrote — a member dropped, a
 * value coerced, an envelope rebuilt — would turn a bundle a gatekeeper admits
 * into one the page refuses, and the failure would read as the deployment's
 * fault rather than as ours.
 *
 * `evidence.e2e.spec.ts` covers the same route over real HTTP, where the
 * `Access-Control-Allow-Origin` and `Cache-Control` headers that make it usable
 * from a browser can actually be observed.
 *
 * Since SUP-227 the same route also relays a registered **external** upstream's
 * publication, so the inspect panel can verify another deployment's evidence in
 * the browser (ADR-008 §7). The property under test there is the same one plus
 * one more: byte-for-byte, and *which* publication — the one the last verdict
 * named, never merely the newest row the poller happens to hold.
 */
import { randomUUID } from 'node:crypto';
import { loadCaseBody, loadConformanceManifest } from '@confidential-router/attestation-fixtures';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteFixture, type SqliteFixture } from '../../../test/sqlite.js';
import type { routerConfig } from '../config.js';
import { type RouterConfig, RouterConfigSchema } from '../config.schema.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { ExternalEvidenceService } from '../external-endpoints/external-evidence.service.js';
import { EvidenceController } from './evidence.controller.js';
import { EvidenceService } from './evidence.service.js';
import { parseEvidenceBundle } from './evidence-bundle.js';

const HOSTNAME = 'router.example.test';
const OTHER_HOSTNAME = 'second.example.test';

const manifest = loadConformanceManifest();

/** A bundle a gatekeeper admits, from the cross-implementation vectors. */
function fixtureBundle(): Record<string, unknown> {
  const testCase = manifest.cases.find((c) => c.id === 'valid-rsa-deployment');
  if (!testCase) throw new Error('the conformance manifest no longer carries valid-rsa-deployment');
  return loadCaseBody(testCase) as Record<string, unknown>;
}

function config(publicBaseUrl: string): RouterConfig {
  return RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32) },
    evidence: { freshnessWindow: '24h' },
    server: { publicBaseUrl },
  });
}

async function seedEndpoint(dataSource: DataSource, name: string, hostname: string): Promise<string> {
  const id = randomUUID();
  await dataSource.getRepository(Endpoint).save({
    id,
    name,
    hostname,
    tee: 'Intel TDX',
    evidenceUrl: null,
    enabled: true,
    updatedAt: new Date(),
  });
  return id;
}

/** An upstream row a verdict has already admitted, pinned to the fixture's own leaf. */
async function seedExternalEndpoint(
  dataSource: DataSource,
  overrides: Partial<ExternalEndpoint> = {},
): Promise<ExternalEndpoint> {
  const parsed = parseEvidenceBundle(fixtureBundle(), HOSTNAME);
  const now = new Date('2026-10-06T12:00:00.000Z');
  const row = {
    id: randomUUID(),
    name: 'partner-cloud',
    baseUrl: `https://${HOSTNAME}`,
    hostname: HOSTNAME,
    listenPort: 19_000,
    enabled: true,
    status: 'verified',
    lastCheckedAt: now,
    lastStage: null,
    lastReason: null,
    measurementSeen: 'a'.repeat(64),
    measurementSource: 'operator-pinned',
    evidenceDigestSeen: parsed.digest.canonical,
    pinnedCertFingerprint: parsed.certFingerprint,
    apiKeyCiphertext: 'v1.sealed',
    apiKeyPrefix: 'sk-upstr',
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ExternalEndpoint;
  await dataSource.getRepository(ExternalEndpoint).save(row);
  return row;
}

let fixture: SqliteFixture;

interface Harness {
  controller: EvidenceController;
  service: EvidenceService;
  external: ExternalEvidenceService;
}

/** Controller over the real services and a migrated database — no mock in the path. */
function controllerOn(publicBaseUrl: string): Harness {
  const service = new EvidenceService(config(publicBaseUrl) as ConfigType<typeof routerConfig>, fixture.dataSource);
  const external = new ExternalEvidenceService(fixture.dataSource);
  return { controller: new EvidenceController(service, external), service, external };
}

/**
 * Files an upstream's publication through the real path the poller uses.
 *
 * `refresh` rather than a hand-written row, because what it enforces is half the
 * property under test: a bundle is filed only when the leaf it claims is the leaf
 * the verdict pinned. A row inserted directly would let the relay tests pass over
 * a document the poller would have refused.
 */
async function storeUpstreamBundle(
  external: ExternalEvidenceService,
  endpoint: ExternalEndpoint,
  raw: Record<string, unknown> = fixtureBundle(),
): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify(raw), { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
  );
  try {
    await external.refresh(endpoint);
  } finally {
    vi.unstubAllGlobals();
  }
}

beforeEach(async () => {
  fixture = await createSqliteFixture('cr-evidence-relay-');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fixture?.close();
});

describe('relaying one endpoint’s bundle', () => {
  it('hands back the stored document byte for byte', async () => {
    const { controller, service } = controllerOn(`https://${HOSTNAME}`);
    const endpointId = await seedEndpoint(fixture.dataSource, 'router', HOSTNAME);
    const stored = await service.record(endpointId, parseEvidenceBundle(fixtureBundle(), HOSTNAME));

    const relayed = await controller.latest('router');

    // Serialised rather than deep-compared: a reordered member is a different
    // document to anything hashing the response, which is what the acceptance
    // check on a real deployment does.
    expect(JSON.stringify(relayed)).toBe(JSON.stringify(stored.bundle));
  });

  it('keeps the signed bytes and the chain the publisher published', async () => {
    const { controller, service } = controllerOn(`https://${HOSTNAME}`);
    const endpointId = await seedEndpoint(fixture.dataSource, 'router', HOSTNAME);
    const published = fixtureBundle();
    await service.record(endpointId, parseEvidenceBundle(published, HOSTNAME));

    const relayed = await controller.latest('router');

    expect(relayed.jws).toBe(published.jws);
    expect(relayed.certChain).toEqual(published.certChain);
    expect(relayed.certFingerprint).toBe(published.certFingerprint);
    expect(relayed.tlsLeaf).toBe(published.tlsLeaf);
    // Passed through unread, placeholder and all: the gate reads `format` off it
    // for display and a display field must not be able to fail a bundle.
    expect(relayed.rootCaTeeQuote).toEqual(published.rootCaTeeQuote);
  });

  it('answers to a hostname as well as to a name', async () => {
    const { controller, service } = controllerOn(`https://${HOSTNAME}`);
    const endpointId = await seedEndpoint(fixture.dataSource, 'router', HOSTNAME);
    await service.record(endpointId, parseEvidenceBundle(fixtureBundle(), HOSTNAME));

    expect(await controller.latest(HOSTNAME)).toMatchObject({ hostname: HOSTNAME });
  });

  it('refuses an endpoint it does not have with a 404', async () => {
    const { controller } = controllerOn(`https://${HOSTNAME}`);

    await expect(controller.latest('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('says "not fetched yet" with a typed reason rather than denying the endpoint', async () => {
    const { controller } = controllerOn(`https://${HOSTNAME}`);
    await seedEndpoint(fixture.dataSource, 'router', HOSTNAME);

    // The distinction the gate renders: a deployment waiting on its first poll
    // is not a router that has never heard of the endpoint.
    const error = await controller.latest('router').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      statusCode: 503,
      reason: 'evidence_not_fetched',
    });
    // Never an empty 200: a caller that verifies what it is handed must not have
    // to tell a bundle from the absence of one.
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
  });
});

describe('relaying this deployment’s own bundle', () => {
  it('resolves the endpoint whose hostname the service publishes on', async () => {
    const { controller, service } = controllerOn(`https://${HOSTNAME}`);
    const own = await seedEndpoint(fixture.dataSource, 'router', HOSTNAME);
    await seedEndpoint(fixture.dataSource, 'second', OTHER_HOSTNAME);
    await service.record(own, parseEvidenceBundle(fixtureBundle(), HOSTNAME));

    expect(await controller.own()).toMatchObject({ hostname: HOSTNAME });
  });

  it('falls back to the one endpoint there is when the published address is not it', async () => {
    // The compose stack and the e2e harness: the router publishes on 127.0.0.1
    // while its single endpoint lives on a mock host's name.
    const { controller, service } = controllerOn('http://127.0.0.1:3000');
    const only = await seedEndpoint(fixture.dataSource, 'demo-tee', HOSTNAME);
    await service.record(only, parseEvidenceBundle(fixtureBundle(), HOSTNAME));

    expect(await controller.own()).toMatchObject({ hostname: HOSTNAME });
  });

  it('refuses to guess between two endpoints neither of which it publishes on', async () => {
    const { controller } = controllerOn('http://127.0.0.1:3000');
    await seedEndpoint(fixture.dataSource, 'router', HOSTNAME);
    await seedEndpoint(fixture.dataSource, 'second', OTHER_HOSTNAME);

    await expect(controller.own()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('says "not fetched yet" for its own endpoint too', async () => {
    const { controller } = controllerOn(`https://${HOSTNAME}`);
    await seedEndpoint(fixture.dataSource, 'router', HOSTNAME);

    const error = await controller.own().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ reason: 'evidence_not_fetched' });
  });
});

describe('relaying a registered external upstream’s bundle', () => {
  it('hands back the upstream’s stored document byte for byte', async () => {
    const { controller, external } = controllerOn('http://127.0.0.1:3000');
    const endpoint = await seedExternalEndpoint(fixture.dataSource);
    await storeUpstreamBundle(external, endpoint);

    const relayed = await controller.latest('partner-cloud');

    // The same serialised comparison the own-endpoint case makes: the browser
    // verifies a JWS over these bytes, so a reordered member is a different
    // document and would turn a bundle the upstream's gatekeeper admits into one
    // the inspect panel refuses.
    expect(JSON.stringify(relayed)).toBe(JSON.stringify(fixtureBundle()));
  });

  it('keeps the signed bytes, so the panel verifies the upstream’s own signature', async () => {
    const { controller, external } = controllerOn('http://127.0.0.1:3000');
    const endpoint = await seedExternalEndpoint(fixture.dataSource);
    await storeUpstreamBundle(external, endpoint);
    const published = fixtureBundle();

    const relayed = await controller.latest('partner-cloud');

    expect(relayed.jws).toBe(published.jws);
    expect(relayed.certChain).toEqual(published.certChain);
    expect(relayed.tlsLeaf).toBe(published.tlsLeaf);
  });

  it('says "not fetched yet" before the first poll rather than denying the endpoint', async () => {
    const { controller } = controllerOn('http://127.0.0.1:3000');
    await seedExternalEndpoint(fixture.dataSource);

    // A registered upstream the poller has not reached yet. The chat's gate
    // renders this as "waiting", and a 404 here would read as this router
    // refusing the endpoint.
    const error = await controller.latest('partner-cloud').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      statusCode: 503,
      reason: 'evidence_not_fetched',
    });
  });

  it('says "not fetched yet" for an upstream no verdict has named a digest for', async () => {
    const { controller, external } = controllerOn('http://127.0.0.1:3000');
    // The publication is on file, but this endpoint's last verdict named no
    // digest — so there is nothing the relay is entitled to call current.
    const stored = await seedExternalEndpoint(fixture.dataSource);
    await storeUpstreamBundle(external, stored);
    await fixture.dataSource.getRepository(ExternalEndpoint).update({ id: stored.id }, { evidenceDigestSeen: null });

    const error = await controller.latest('partner-cloud').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
  });

  it('relays a denied upstream’s last admitted publication, without saying anything about it', async () => {
    const { controller, external } = controllerOn('http://127.0.0.1:3000');
    const endpoint = await seedExternalEndpoint(fixture.dataSource);
    await storeUpstreamBundle(external, endpoint);
    await fixture.dataSource
      .getRepository(ExternalEndpoint)
      .update({ id: endpoint.id }, { status: 'denied', lastStage: 'policy', lastReason: 'measurement not admitted' });

    const relayed = await controller.latest('partner-cloud');

    // The relay has never carried a verdict in either direction (ADR-002). The
    // screens that do carry one say "denied by this router" in words; a refusal
    // here would make this the third, least legible place a verdict is expressed.
    expect(JSON.stringify(relayed)).toBe(JSON.stringify(fixtureBundle()));
    expect(Object.keys(relayed)).not.toContain('status');
  });

  it('refuses an upstream it has never heard of with a 404', async () => {
    const { controller } = controllerOn('http://127.0.0.1:3000');
    await seedExternalEndpoint(fixture.dataSource);

    await expect(controller.latest('some-other-cloud')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers for one of our own endpoints first when a name is in both tables', async () => {
    const { controller, external } = controllerOn('http://127.0.0.1:3000');
    // Ours has nothing stored; the upstream's bundle is on file. If the external
    // table were consulted first, this call would succeed — so the 503 is the
    // assertion, and it is a sharper one than comparing two copies of the same
    // conformance document would be.
    await seedEndpoint(fixture.dataSource, 'shared', OTHER_HOSTNAME);
    const upstream = await seedExternalEndpoint(fixture.dataSource, { name: 'shared' });
    await storeUpstreamBundle(external, upstream);

    const error = await controller.latest('shared').catch((caught: unknown) => caught);

    // The two name spaces are separate tables precisely so this cannot happen;
    // when it does, the safe reading is the one where this deployment answers
    // for itself rather than for somebody else's.
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      message: expect.stringContaining('endpoint "shared"'),
    });
  });
});
