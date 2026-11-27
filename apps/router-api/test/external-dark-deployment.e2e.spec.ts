import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ExternalEndpoint } from '../src/app/db/entities/external-endpoint.entity.js';
import { ExternalEndpointStatusService } from '../src/app/external-endpoints/index.js';
import { createHarness, type Harness } from './app-harness.js';
import { seedExternalEndpoint } from './seed.js';

/**
 * A rebuilt deployment that can serve nothing has to say so (SUP-879).
 *
 * The train on 2026-11-22 succeeded and production advertised no models at all
 * for about four minutes, because a data import lands every external endpoint
 * switched off and with an empty key envelope — the bundle carries no secrets,
 * which is right — and nothing downstream treated the re-key as a step the
 * operator still owed. `GET /v1/models` answered `[]`, `/admin/health` reported
 * `externalEndpoints: {"status":"none","registered":0,…}` inside a document whose
 * own `status` read `ok`, and the marketplace showed the deployment running and
 * published. The operator who has just rebuilt production is the least likely
 * person to notice a quiet zero, because everything they are actively checking —
 * hostnames, evidence, sign-in, the data counts — passes.
 *
 * So this suite asserts the two things that were missing: the document says
 * `outage` with the counts that explain it, and a message leaves the deployment.
 * The clock is driven by hand (`statusPollInterval: 0ms`) because the threshold
 * the alert waits for is fifteen minutes of real time.
 */

const OPERATOR = 'ops@example.test';
const DIGEST = 'sha256/approved-deployment';
const IMPORTED = new Date('2026-11-22T16:27:00.000Z');
/** Past `externalEndpoints.outage.afterNoSuccess`, which production leaves at 15m. */
const SUSTAINED = new Date(IMPORTED.getTime() + 16 * 60_000);

let harness: Harness;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cr-dark-'));
  harness = await createHarness({
    env: {
      CR_API_AUTH__ADMIN_EMAILS: OPERATOR,
      CR_API_EXTERNAL_ENDPOINTS__CONFIG_FILE: join(dir, 'gatekeeper', 'config.yaml'),
      // No sidecar, and the passes below are driven by hand: the alert this
      // suite is about waits on elapsed time, not on a verdict.
      CR_API_EXTERNAL_ENDPOINTS__STATUS_POLL_INTERVAL: '0ms',
    },
  });
});

afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as Harness;
  rmSync(dir, { recursive: true, force: true });
});

/** The rows `DataImportService` writes: off, approved once, with no key to open. */
async function imported(): Promise<void> {
  const dataSource = harness.app.get(DataSource);
  const endpoint = await seedExternalEndpoint(dataSource, {
    enabled: false,
    status: 'disabled',
    pinnedEvidenceDigest: DIGEST,
  });
  await dataSource
    .getRepository(ExternalEndpoint)
    .update({ id: endpoint.id }, { apiKeyCiphertext: '', apiKeyPrefix: '' });
}

async function pass(now: Date): Promise<void> {
  await harness.app.get(ExternalEndpointStatusService).refreshFromRows(now);
}

it('reports an outage and writes to an operator once a rebuilt deployment stays dark', async () => {
  await imported();

  await pass(IMPORTED);
  const booting = await request(harness.app.getHttpServer()).get('/health').expect(200);
  // Dark, and quiet about it: a pod that is about to be fine looks like this for
  // the poll or two before its first verdict lands.
  expect(booting.body.externalEndpoints).toMatchObject({ status: 'degraded', models: 1, routableModels: 0 });
  expect(harness.mailer.ofKind('operator-alert')).toHaveLength(0);

  await pass(SUSTAINED);

  const response = await request(harness.app.getHttpServer()).get('/health').expect(200);
  expect(response.body.externalEndpoints).toMatchObject({
    status: 'outage',
    registered: 0,
    disabled: 1,
    awaitingKey: 1,
    models: 1,
    routableModels: 0,
  });
  // …and it must still not take the deployment out of the load-balancer
  // rotation: the console, the sign-in and every other route are fine, and a
  // pod that is removed for a dark upstream is a dark deployment.
  expect(response.body.status).toBe('ok');

  const alerted = harness.mailer.ofKind('operator-alert');
  expect(alerted).toHaveLength(1);
  expect(alerted[0].to).toBe(OPERATOR);
  expect(alerted[0].subject).toContain('serving no models');
  expect(alerted[0].text).toContain('upstream API key');
  // Counts, never identity: mail gets forwarded (SUP-221 ruling 3).
  expect(alerted[0].text).not.toContain('upstream-');
}, 60_000);

it('keeps the public document free of upstream identity while it is dark', async () => {
  await imported();
  await pass(IMPORTED);
  await pass(SUSTAINED);

  const response = await request(harness.app.getHttpServer()).get('/health').expect(200);

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
    'since',
    'status',
    'unreachable',
  ]);
}, 60_000);
