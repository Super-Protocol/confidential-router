import type { ConfigType } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDataSource, seedExternalEndpoint } from '../../../test/seed.js';
import type { routerConfig } from '../config.js';
import { RouterConfigSchema } from '../config.schema.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { ExternalEndpointEvent } from '../db/entities/external-endpoint-event.entity.js';
import { ExternalCatalogService } from './external-catalog.service.js';
import { ExternalEndpointStatusService } from './external-endpoint-status.service.js';
import type { SidecarVerdict } from './sidecar-admin.client.js';
import * as adminClient from './sidecar-admin.client.js';

const MEASUREMENT = 'a'.repeat(64);
const DIGEST = 'sha256/BvG0Yy3Ir0QKPtC1TrSPuyZZD1sdKq7Gq_a1Mv1Hs0A';
const OTHER_DIGEST = 'sha256/CwH1Zz4Js1RLQudD2UsTQvzaaE2teLr8Hr_b2Nw2It1B';
const FINGERPRINT = 'sha256/leafleafleafleafleafleafleafleafleafleafle0';

let dataSource: DataSource;
let catalog: ExternalCatalogService;
let service: ExternalEndpointStatusService;

function config(): ConfigType<typeof routerConfig> {
  return RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32) },
    externalEndpoints: { adminListen: '127.0.0.1:9465' },
  }) as ConfigType<typeof routerConfig>;
}

/** Answers the next `/verdicts` read with exactly these entries. */
function sidecarReports(...verdicts: SidecarVerdict[]): void {
  vi.spyOn(adminClient, 'fetchSidecarVerdicts').mockResolvedValue(verdicts);
}

function verified(name: string, overrides: Partial<SidecarVerdict['report']> = {}): SidecarVerdict {
  return {
    endpoint: name,
    health: 'confidential',
    admitted: true,
    report: {
      checkedAt: '2026-10-06T11:59:58.000Z',
      verified: true,
      admitted: true,
      attestedRoot: { measurement: MEASUREMENT, measurementSource: 'operator-pinned' },
      certFingerprint: FINGERPRINT,
      evidenceDigest: DIGEST,
      ...overrides,
    },
  };
}

function refused(name: string): SidecarVerdict {
  return {
    endpoint: name,
    health: 'broken',
    admitted: false,
    reason: 'policy: the measurement is not in the trusted list',
    report: { checkedAt: '2026-10-06T11:59:58.000Z', verified: true, admitted: false, stage: 'policy' },
  };
}

beforeEach(async () => {
  dataSource = await createTestDataSource();
  catalog = new ExternalCatalogService(dataSource);
  service = new ExternalEndpointStatusService(config(), dataSource, catalog);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dataSource.destroy();
});

async function rowOf(id: string): Promise<ExternalEndpoint> {
  return dataSource.getRepository(ExternalEndpoint).findOneByOrFail({ id });
}

async function eventsOf(id: string): Promise<ExternalEndpointEvent[]> {
  return dataSource
    .getRepository(ExternalEndpointEvent)
    .find({ where: { externalEndpointId: id }, order: { kind: 'ASC' } });
}

describe('resetToPending', () => {
  it('drops every verdict column, so a restart cannot inherit trust', async () => {
    // ADR-008 §8: the sidecar starts with no verdict and attests from nothing, so
    // a row that survived saying `verified` would be a trust decision nobody made
    // in this process.
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await dataSource.getRepository(ExternalEndpoint).update(
      { id: endpoint.id },
      {
        measurementSeen: MEASUREMENT,
        measurementSource: 'registry',
        evidenceDigestSeen: DIGEST,
        pinnedCertFingerprint: FINGERPRINT,
        lastCheckedAt: new Date(),
      },
    );

    await expect(service.resetToPending()).resolves.toBe(1);

    expect(await rowOf(endpoint.id)).toMatchObject({
      status: 'pending',
      measurementSeen: null,
      measurementSource: null,
      measurementInRegistry: null,
      evidenceDigestSeen: null,
      pinnedCertFingerprint: null,
      lastCheckedAt: null,
    });
  });

  it('takes the endpoint out of the routable catalogue', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await catalog.refresh();
    expect(catalog.list()).toHaveLength(1);

    await service.resetToPending();

    expect(catalog.list()).toEqual([]);
    expect(catalog.find(endpoint.modelId)).toBeUndefined();
  });

  it('writes no event, because nothing happened to the endpoint', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });

    await service.resetToPending();

    expect(await eventsOf(endpoint.id)).toEqual([]);
  });

  it('clears a pending endpoint that was checked — awaiting approval is a verdict too (SUP-252)', async () => {
    // `digest-not-pinned` is `pending` with both factors on the row and a leaf the
    // evidence poller binds to. From a previous process, none of that is a live
    // observation; the pin itself is trust and stays.
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'pending', pinnedEvidenceDigest: DIGEST });
    await dataSource.getRepository(ExternalEndpoint).update(
      { id: endpoint.id },
      {
        lastStage: 'digest-not-pinned',
        measurementSeen: MEASUREMENT,
        evidenceDigestSeen: DIGEST,
        observedCertFingerprint: FINGERPRINT,
        lastCheckedAt: new Date(),
      },
    );
    const untouched = await seedExternalEndpoint(dataSource, { status: 'pending' });

    await expect(service.resetToPending()).resolves.toBe(1);

    expect(await rowOf(endpoint.id)).toMatchObject({
      status: 'pending',
      lastStage: null,
      measurementSeen: null,
      evidenceDigestSeen: null,
      observedCertFingerprint: null,
      lastCheckedAt: null,
      pinnedEvidenceDigest: DIGEST,
    });
    expect((await rowOf(untouched.id)).status).toBe('pending');
  });

  it('leaves a disabled endpoint alone — that value is the operator’s, not a verdict', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { enabled: false, status: 'disabled' });

    await service.resetToPending();

    expect((await rowOf(endpoint.id)).status).toBe('disabled');
  });
});

describe('sync', () => {
  it('projects an admission and makes the model routable', async () => {
    const endpoint = await seedExternalEndpoint(dataSource);
    await catalog.refresh();
    expect(catalog.list()).toEqual([]);
    sidecarReports(verified(endpoint.name));

    await expect(service.sync()).resolves.toEqual({ seen: 1, flipped: 1, events: 1 });

    expect(await rowOf(endpoint.id)).toMatchObject({
      status: 'verified',
      measurementSeen: MEASUREMENT,
      evidenceDigestSeen: DIGEST,
      pinnedCertFingerprint: FINGERPRINT,
    });
    expect(catalog.list().map((model) => model.id)).toEqual([endpoint.modelId]);
  });

  it('drops the model the moment a verdict turns negative', async () => {
    // Decision 5, as seen from router-api's side: the sidecar refuses at the
    // egress, and admission stops offering the model in the same pass.
    const endpoint = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(endpoint.name));
    await service.sync();
    expect(catalog.list()).toHaveLength(1);

    sidecarReports(refused(endpoint.name));
    await expect(service.sync()).resolves.toMatchObject({ flipped: 1 });

    expect((await rowOf(endpoint.id)).status).toBe('denied');
    expect(catalog.list()).toEqual([]);
  });

  it('writes one event per transition and none per repetition', async () => {
    const endpoint = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(endpoint.name));
    await service.sync();

    await expect(service.sync()).resolves.toEqual({ seen: 1, flipped: 0, events: 0 });
    expect((await eventsOf(endpoint.id)).map((event) => event.kind)).toEqual(['verified']);
  });

  it('does not touch the row when the sidecar repeats the verdict it already had', async () => {
    // At a five-second poll and a ten-minute re-attestation, most passes carry the
    // verdict the row already holds — `checkedAt` included. A write per pass would
    // be pointless load and would keep `updatedAt` moving on an unchanged row.
    const endpoint = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(endpoint.name));
    await service.sync();
    const after = await rowOf(endpoint.id);

    await expect(service.sync()).resolves.toEqual({ seen: 1, flipped: 0, events: 0 });

    expect((await rowOf(endpoint.id)).updatedAt).toEqual(after.updatedAt);
  });

  it('records a digest change on a still-verified endpoint', async () => {
    const endpoint = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(endpoint.name));
    await service.sync();

    sidecarReports(verified(endpoint.name, { evidenceDigest: OTHER_DIGEST }));
    await expect(service.sync()).resolves.toEqual({ seen: 1, flipped: 0, events: 1 });

    const events = await eventsOf(endpoint.id);
    expect(events.map((event) => event.kind).sort()).toEqual(['digest_changed', 'verified']);
    expect(events.find((event) => event.kind === 'digest_changed')?.evidenceDigest).toBe(OTHER_DIGEST);
    expect((await rowOf(endpoint.id)).evidenceDigestSeen).toBe(OTHER_DIGEST);
  });

  it('leaves an endpoint the sidecar did not mention as it was', async () => {
    // Usually a render the sidecar has not picked up yet. Overwriting a live
    // verdict because one poll raced a reload would flap the catalogue.
    const known = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(known.name));
    await service.sync();

    sidecarReports();
    await expect(service.sync()).resolves.toEqual({ seen: 0, flipped: 0, events: 0 });

    expect((await rowOf(known.id)).status).toBe('verified');
    expect(catalog.list()).toHaveLength(1);
  });

  it('ignores a verdict about an endpoint this deployment does not have', async () => {
    await seedExternalEndpoint(dataSource);
    sidecarReports(verified('some-other-name'));

    await expect(service.sync()).resolves.toEqual({ seen: 0, flipped: 0, events: 0 });
  });

  it('does not project onto a disabled endpoint', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { enabled: false, status: 'disabled' });
    sidecarReports(verified(endpoint.name));

    await expect(service.sync()).resolves.toEqual({ seen: 0, flipped: 0, events: 0 });
    expect((await rowOf(endpoint.id)).status).toBe('disabled');
  });

  it('projects several endpoints in one pass', async () => {
    const first = await seedExternalEndpoint(dataSource);
    const second = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(first.name), refused(second.name));

    await expect(service.sync()).resolves.toEqual({ seen: 2, flipped: 2, events: 2 });

    expect((await rowOf(first.id)).status).toBe('verified');
    expect((await rowOf(second.id)).status).toBe('denied');
    expect(catalog.list().map((model) => model.id)).toEqual([first.modelId]);
  });

  it('lets a transport failure out, so the poller can report it once', async () => {
    vi.spyOn(adminClient, 'fetchSidecarVerdicts').mockRejectedValue(
      new adminClient.SidecarUnavailableError('/verdicts', 'ECONNREFUSED'),
    );

    await expect(service.sync()).rejects.toThrow(adminClient.SidecarUnavailableError);
  });
});

describe('recordEvent', () => {
  it('appends an event the sidecar has no opinion about', async () => {
    const endpoint = await seedExternalEndpoint(dataSource);

    await service.recordEvent(endpoint.id, 'registered');

    expect((await eventsOf(endpoint.id)).map((event) => event.kind)).toEqual(['registered']);
  });
});
