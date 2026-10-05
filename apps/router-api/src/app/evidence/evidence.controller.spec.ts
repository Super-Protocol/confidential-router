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
 */
import { randomUUID } from 'node:crypto';
import { loadCaseBody, loadConformanceManifest } from '@confidential-router/attestation-fixtures';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteFixture, type SqliteFixture } from '../../../test/sqlite.js';
import type { routerConfig } from '../config.js';
import { type RouterConfig, RouterConfigSchema } from '../config.schema.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
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

let fixture: SqliteFixture;

/** Controller over the real service and a migrated database — no mock in the path. */
function controllerOn(publicBaseUrl: string): { controller: EvidenceController; service: EvidenceService } {
  const service = new EvidenceService(config(publicBaseUrl) as ConfigType<typeof routerConfig>, fixture.dataSource);
  return { controller: new EvidenceController(service), service };
}

beforeEach(async () => {
  fixture = await createSqliteFixture('cr-evidence-relay-');
});

afterEach(async () => {
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
