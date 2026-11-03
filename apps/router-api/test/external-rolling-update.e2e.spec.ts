import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ExternalEndpoint } from '../src/app/db/entities/external-endpoint.entity.js';
import { Model } from '../src/app/db/entities/model.entity.js';
import { ExternalEndpointStatusService } from '../src/app/external-endpoints/index.js';
import { SecretEnvelopeService } from '../src/app/secrets/index.js';
import { createHarness, type Harness } from './app-harness.js';
import { bearer, createKey, routerConfigFor, seedWorkspace } from './gateway-fixture.js';
import { MockLiteLlm } from './mock-litellm.js';
import { MockEgressSidecar } from './mock-sidecar.js';

/**
 * A deploy train, end to end: the pod that survives it has to serve the external
 * model (SUP-600).
 *
 * The defect this suite exists for took production's `/v1` dark on every train
 * until an operator cycled the endpoint by hand, and no single-process test could
 * see it, because it needs **two** router-api processes on one database. That is
 * not a hypothetical: the chart ships `replicaCount: 1` with no `strategy`, so
 * Kubernetes' default rolling update is `maxSurge: 1, maxUnavailable: 0` — the new
 * pod boots, and becomes Ready, beside the old one.
 *
 * What that overlap does, in order:
 *
 *  1. the new pod's `resetToPending` holds every row at `pending` (ADR-008 §8) and
 *     builds its catalogue from them, so the catalogue is empty;
 *  2. the old pod — still taking every request — polls its own sidecar, projects
 *     the admission and writes `verified` back;
 *  3. the new pod polls its own sidecar, which admits, and finds a row that
 *     already says `verified`. Nothing flipped.
 *
 * Step 3 is where it used to end: the catalogue was rebuilt only when this process
 * had itself seen the admission move, so the new pod kept the empty one for the
 * life of the pod. `/v1/models` answered `[]` and every completion was a 503
 * `attestation_failed`, while `/admin/health` read the row and reported the
 * upstream as serving — the two readers disagreeing is what made the outage hard
 * to see rather than merely bad.
 *
 * Both pods drive `sync` by hand, as `v1-external.e2e.spec.ts` does: the
 * projection is real, its timing is not, and the interleaving above is the whole
 * point of the test.
 */

const litellm = new MockLiteLlm();
/** One per pod: the sidecar is a container in the pod, so each incarnation has its own. */
const oldSidecar = new MockEgressSidecar();
const newSidecar = new MockEgressSidecar();

const NAME = 'partner-train';
const MODEL_ID = 'partner/train:snp';
const UPSTREAM_KEY = 'sk-partner-upstream-0123456789';
const DIGEST = 'sha256/upstream-bundle';

let dir: string;
let litellmUrl: string;
let secret: string;
let endpointId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cr-train-'));
  litellmUrl = await litellm.start();
}, 60_000);

afterAll(async () => {
  await oldSidecar.stop();
  await newSidecar.stop();
  await litellm.stop();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * One router-api process against the shared database — a pod, as far as this
 * suite is concerned. `tag` keeps the rendered sidecar config files apart, the
 * way two pods' `emptyDir` volumes are.
 */
async function pod(sidecar: MockEgressSidecar, tag: string): Promise<Harness> {
  return createHarness({
    env: {
      CR_API_DATABASE__FILE: join(dir, 'router.sqlite'),
      CR_API_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64url'),
    },
    config: routerConfigFor(litellmUrl, {
      externalEndpoints: {
        adminListen: await sidecar.adminApi(),
        configFile: join(dir, `gatekeeper-${tag}.yaml`),
        statusPollInterval: 0,
      },
    }),
  });
}

async function models(harness: Harness): Promise<string[]> {
  const response = await request(harness.app.getHttpServer()).get('/v1/models').set(bearer(secret)).expect(200);
  return (response.body.data as { id: string }[]).map((model) => model.id);
}

/** Registers the upstream and its model, as the admin API would (stage 4). */
async function register(harness: Harness, listenPort: number): Promise<void> {
  endpointId = randomUUID();
  const sealed = harness.app.get(SecretEnvelopeService).seal(UPSTREAM_KEY, endpointId);
  const now = new Date();
  await harness.app
    .get(DataSource)
    .getRepository(ExternalEndpoint)
    .save({
      id: endpointId,
      name: NAME,
      baseUrl: `https://${NAME}.partner.example`,
      hostname: `${NAME}.partner.example`,
      listenPort,
      enabled: true,
      status: 'pending',
      pinnedEvidenceDigest: DIGEST,
      apiKeyCiphertext: sealed.ciphertext,
      apiKeyPrefix: sealed.prefix,
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
  await harness.app
    .get(DataSource)
    .getRepository(Model)
    .save({
      id: MODEL_ID,
      name: 'Partner train',
      litellmModel: 'partner-chat',
      origin: 'external',
      endpointId: null,
      externalEndpointId: endpointId,
      contextLength: 4096,
      capabilities: ['chat'],
      promptPer1mMicros: 1_000_000,
      completionPer1mMicros: 1_000_000,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
}

it('the pod that survives a rolling update serves the external model', async () => {
  const oldPort = await oldSidecar.listener(NAME);
  oldSidecar.admit(NAME, { evidenceDigest: DIGEST });
  const previous = await pod(oldSidecar, 'old');
  const workspace = await seedWorkspace(previous.app, 10_000_000);
  secret = (await createKey(previous.app, workspace.id)).secret;
  await register(previous, oldPort);

  await previous.app.get(ExternalEndpointStatusService).sync();
  expect(await models(previous)).toContain(MODEL_ID);

  // The new pod comes up beside it, with its own sidecar on its own loopback
  // port, and holds every row at `pending` on the way through boot.
  const newPort = await newSidecar.listener(NAME);
  newSidecar.admit(NAME, { evidenceDigest: DIGEST });
  await previous.app
    .get(DataSource)
    .getRepository(ExternalEndpoint)
    .update({ id: endpointId }, { listenPort: newPort });
  const current = await pod(newSidecar, 'new');
  const rows = current.app.get(DataSource).getRepository(ExternalEndpoint);
  expect((await rows.findOneByOrFail({ id: endpointId })).status).toBe('pending');

  // The old pod is still Ready and still polling, so it re-verifies the row the
  // new pod just reset — and it is the *old* pod that saw the transition.
  await previous.app.get(ExternalEndpointStatusService).sync();
  expect((await rows.findOneByOrFail({ id: endpointId })).status).toBe('verified');

  // The new pod's own poll: its sidecar admits, and the row already agrees.
  await expect(current.app.get(ExternalEndpointStatusService).sync()).resolves.toMatchObject({ seen: 1, flipped: 0 });

  // The old pod is drained. Everything now goes to the pod that never saw a flip.
  await previous.app.close();
  expect(await models(current)).toContain(MODEL_ID);
  await request(current.app.getHttpServer())
    .post('/v1/chat/completions')
    .set(bearer(secret))
    .send({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] })
    .expect(200);

  // And the health document's two readers agree. During the outage they did not,
  // and nothing in it said so: `serving: 1` was the whole answer an operator got
  // while `/v1` refused everything (SUP-600).
  const health = await request(current.app.getHttpServer()).get('/health').expect(200);
  expect(health.body.externalEndpoints).toMatchObject({ status: 'ok', serving: 1, routableModels: 1 });
  await current.close();
}, 120_000);
