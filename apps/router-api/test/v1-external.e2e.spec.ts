import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CreditTransaction } from '../src/app/db/entities/credit-transaction.entity.js';
import { ExternalEndpoint, type ExternalEndpointStatus } from '../src/app/db/entities/external-endpoint.entity.js';
import { Generation } from '../src/app/db/entities/generation.entity.js';
import { Model } from '../src/app/db/entities/model.entity.js';
import { ExternalCatalogService, ExternalEndpointStatusService } from '../src/app/external-endpoints/index.js';
import { SecretEnvelopeService } from '../src/app/secrets/index.js';
import { createHarness, type Harness, listen } from './app-harness.js';
import { bearer, createKey, routerConfigFor, seedWorkspace } from './gateway-fixture.js';
import { COMPLETION_BODY, MockLiteLlm, STREAM_CHUNKS, STREAM_USAGE } from './mock-litellm.js';
import { MockEgressSidecar, type SidecarBehaviour } from './mock-sidecar.js';

/**
 * The external egress leg, end to end (ADR-008 §4, SUP-224).
 *
 * Two claims are under test and they pull in opposite directions. One: a model in
 * someone else's deployment is served through a different forward target, with a
 * credential router-api injects and a fail-closed refusal when no verdict admits
 * it. Two: *nothing else changes* — admission, rate limits, metering, the SSE
 * relay and response shaping behave identically, which is why several assertions
 * here compare an external response against the built-in mock's own constants
 * rather than against a hand-written expectation.
 *
 * `statusPollInterval` is 0 and the status sync is driven by hand: the projection
 * is real, its timing is not, and a five-second poll racing an assertion would
 * make this suite flap for reasons that have nothing to do with the egress leg.
 */

/** One micro-USD per token, as `gateway-fixture` prices the built-ins. */
const PRICING = { promptPer1mMicros: 1_000_000, completionPer1mMicros: 1_000_000 };

const UPSTREAM_DIGEST = 'sha256/upstream-bundle';
const UPSTREAM_KEY = 'sk-partner-upstream-0123456789';
const START_BALANCE = 10_000_000;

interface Registered {
  id: string;
  name: string;
  hostname: string;
  modelId: string;
}

const litellm = new MockLiteLlm();
const sidecar = new MockEgressSidecar();

let harness: Harness;
let baseUrl: string;
let secret: string;
let workspaceId: string;
let configDir: string;

beforeAll(async () => {
  const litellmUrl = await litellm.start();
  const adminListen = await sidecar.adminApi();
  configDir = mkdtempSync(join(tmpdir(), 'cr-sidecar-'));

  harness = await createHarness({
    env: {
      // 32 bytes, base64url. The egress leg cannot inject a credential it cannot
      // open, so without this the suite would be testing the missing-key path.
      CR_API_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64url'),
    },
    config: routerConfigFor(litellmUrl, {
      externalEndpoints: {
        adminListen,
        configFile: join(configDir, 'gatekeeper.yaml'),
        statusPollInterval: 0,
      },
    }),
  });
  baseUrl = await listen(harness);
  workspaceId = (await seedWorkspace(harness.app, START_BALANCE)).id;
  secret = (await createKey(harness.app, workspaceId)).secret;
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await sidecar.stop();
  await litellm.stop();
  rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  litellm.reset();
  sidecar.reset();
});

function dataSource(): DataSource {
  return harness.app.get(DataSource);
}

/**
 * Registers an external endpoint the way the admin API will (stage 4): a row with
 * a sealed upstream key, a catalogue row of `origin: external`, and a listener on
 * the sidecar it points at.
 */
async function register(
  name: string,
  options: { status?: ExternalEndpointStatus; behaviour?: SidecarBehaviour; admitted?: boolean } = {},
): Promise<Registered> {
  const id = randomUUID();
  const modelId = `partner/${name}:snp`;
  const hostname = `${name}.partner.example`;
  const listenPort = await sidecar.listener(name);
  const now = new Date();
  // Sealed under the row id, which is the envelope's AAD context: a ciphertext
  // moved between rows fails to open rather than redirecting one upstream's
  // credential to another.
  const sealed = harness.app.get(SecretEnvelopeService).seal(UPSTREAM_KEY, id);

  await dataSource()
    .getRepository(ExternalEndpoint)
    .save({
      id,
      name,
      baseUrl: `https://${hostname}`,
      hostname,
      listenPort,
      enabled: true,
      status: options.status ?? 'verified',
      lastCheckedAt: now,
      lastStage: null,
      lastReason: null,
      measurementSeen: 'a'.repeat(64),
      measurementSource: 'operator-pinned',
      evidenceDigestSeen: UPSTREAM_DIGEST,
      pinnedCertFingerprint: 'sha256/leaf',
      apiKeyCiphertext: sealed.ciphertext,
      apiKeyPrefix: sealed.prefix,
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
  await dataSource()
    .getRepository(Model)
    .save({
      id: modelId,
      name: `Partner ${name}`,
      litellmModel: 'partner-chat',
      origin: 'external',
      endpointId: null,
      externalEndpointId: id,
      contextLength: 8192,
      capabilities: ['chat', 'completions'],
      ...PRICING,
      tee: 'AMD SEV-SNP',
      enabled: true,
      updatedAt: now,
    });

  if (options.admitted ?? true) {
    sidecar.admit(name, { evidenceDigest: UPSTREAM_DIGEST });
  } else {
    sidecar.withdraw(name);
  }
  sidecar.behaviour.set(name, options.behaviour ?? 'serve');
  await harness.app.get(ExternalCatalogService).refresh();
  return { id, name, hostname, modelId };
}

function chat(modelId: string, body: Record<string, unknown> = {}) {
  return request(harness.app.getHttpServer())
    .post('/v1/chat/completions')
    .set(bearer(secret))
    .send({ model: modelId, messages: [{ role: 'user', content: 'Hello there' }], ...body });
}

async function streamed(modelId: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(secret) },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'Hello there' }],
      stream: true,
      ...body,
    }),
  });
  const text = await response.text();
  const events = text
    .split('\n\n')
    .filter((event) => event.length > 0)
    .map((event) => `${event}\n\n`);
  const chunks = events
    .map((event) => event.replace(/^data: /, '').trim())
    .filter((payload) => payload.startsWith('{'))
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
  return { response, events, chunks };
}

function generationOf(id: string): Promise<Generation> {
  return dataSource().getRepository(Generation).findOneByOrFail({ id });
}

function models(): Promise<{ body: { data: { id: string }[] } }> {
  return request(harness.app.getHttpServer()).get('/v1/models').set(bearer(secret)).expect(200);
}

describe('a verified external endpoint', () => {
  let endpoint: Registered;

  beforeAll(async () => {
    endpoint = await register('verified-cloud');
  });

  it('serves a completion through the sidecar, under the name the upstream knows', async () => {
    const response = await chat(endpoint.modelId).expect(200);

    const forwarded = sidecar.requests.filter((entry) => entry.endpoint === endpoint.name);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].path).toBe('/v1/chat/completions');
    expect(forwarded[0].body.model).toBe('partner-chat');
    // The credential is the upstream's own LLM API key (decision 3), injected by
    // router-api and never part of the sidecar's config (ADR-003 §8).
    expect(forwarded[0].authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    // Nothing went to LiteLLM: this is the other leg entirely.
    expect(litellm.requests).toEqual([]);
    expect(response.body.id).toMatch(/^gen-/);
    expect(response.body.model).toBe(endpoint.modelId);
  });

  it('shapes the response exactly as the built-in leg does', async () => {
    const external = await chat(endpoint.modelId).expect(200);
    const builtIn = await chat('mock/chat:tdx').expect(200);

    // Same envelope, same choices, same usage counts — the only differences are
    // the identity fields and the extension values, which name a different
    // endpoint on purpose.
    expect(external.body.choices).toEqual(COMPLETION_BODY.choices);
    expect(external.body.object).toBe(builtIn.body.object);
    expect(Object.keys(external.body.usage).sort()).toEqual(Object.keys(builtIn.body.usage).sort());
    expect(external.body.usage.prompt_tokens).toBe(STREAM_USAGE.prompt_tokens);
    expect(external.body.usage.completion_tokens).toBe(STREAM_USAGE.completion_tokens);
  });

  it('names the external endpoint and the digest its verdict observed', async () => {
    const response = await chat(endpoint.modelId).expect(200);

    expect(response.body.usage.endpoint).toBe(endpoint.name);
    // Stronger coverage than a built-in's: this digest comes from a verdict the
    // router reached, not merely from something the platform published (ADR-008 §4).
    expect(response.body.usage.evidence_digest).toBe(UPSTREAM_DIGEST);
    expect(response.body.usage.cost_micros).toBe(STREAM_USAGE.prompt_tokens + STREAM_USAGE.completion_tokens);
    expect(response.headers['x-confidential-router-endpoint']).toBe(endpoint.hostname);
  });

  it('meters the generation against the external endpoint, in the built-ins’ shape', async () => {
    const response = await chat(endpoint.modelId).expect(200);

    const generation = await generationOf(response.body.id);
    expect(generation).toMatchObject({
      modelId: endpoint.modelId,
      // Exactly one endpoint, of the kind the row's origin says.
      endpointId: null,
      externalEndpointId: endpoint.id,
      // No snapshot row behind an upstream's bundle; the digest is the verdict's.
      evidenceSnapshotId: null,
      evidenceDigest: UPSTREAM_DIGEST,
      status: 'ok',
      streamed: false,
      // Admin-set prices, frozen per generation exactly as a config model's are.
      promptPer1mMicros: PRICING.promptPer1mMicros,
      completionPer1mMicros: PRICING.completionPer1mMicros,
    });
    expect(generation.costMicros).toBe(STREAM_USAGE.prompt_tokens + STREAM_USAGE.completion_tokens);
  });

  it('debits the ledger exactly as a built-in generation does', async () => {
    const before = await dataSource().getRepository(CreditTransaction).countBy({ workspaceId });
    const response = await chat(endpoint.modelId).expect(200);

    const generation = await generationOf(response.body.id);
    const entries = await dataSource()
      .getRepository(CreditTransaction)
      .findBy({ workspaceId, reference: response.body.id });

    expect(await dataSource().getRepository(CreditTransaction).countBy({ workspaceId })).toBe(before + 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'usage', amountMicros: -generation.costMicros });
  });

  it('appears in /v1/models and resolves by id', async () => {
    expect((await models()).body.data.map((model) => model.id)).toContain(endpoint.modelId);

    const one = await request(harness.app.getHttpServer())
      .get(`/v1/models/${endpoint.modelId}`)
      .set(bearer(secret))
      .expect(200);
    expect(one.body).toMatchObject({
      id: endpoint.modelId,
      endpoint: { name: endpoint.name, hostname: endpoint.hostname, tee: 'AMD SEV-SNP' },
      pricing: { prompt_per_1m_micros: PRICING.promptPer1mMicros },
    });
  });

  it('reports the external endpoint on GET /v1/generation, like usage.endpoint did', async () => {
    const response = await chat(endpoint.modelId).expect(200);

    const reconciled = await request(harness.app.getHttpServer())
      .get(`/v1/generation?id=${response.body.id}`)
      .set(bearer(secret))
      .expect(200);

    expect(reconciled.body.data).toMatchObject({
      endpoint: endpoint.name,
      evidence_digest: UPSTREAM_DIGEST,
    });
  });

  it('relays a stream byte for byte, the same way the built-in leg does', async () => {
    const { response, chunks, events } = await streamed(endpoint.modelId);
    const generationId = response.headers.get('x-confidential-router-generation-id');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('x-confidential-router-endpoint')).toBe(endpoint.hostname);
    expect(chunks).toEqual(STREAM_CHUNKS.map((chunk) => ({ ...chunk, id: generationId, model: endpoint.modelId })));
    expect(events.at(-1)).toBe('data: [DONE]\n\n');

    const generation = await generationOf(generationId as string);
    expect(generation).toMatchObject({ status: 'ok', streamed: true, externalEndpointId: endpoint.id });
  });

  it('counts the usage chunk it asked for without forwarding it', async () => {
    const { chunks, response } = await streamed(endpoint.modelId);
    const generationId = response.headers.get('x-confidential-router-generation-id') as string;

    expect(chunks.filter((chunk) => 'usage' in chunk)).toEqual([]);
    const generation = await generationOf(generationId);
    expect(generation.promptTokens).toBe(STREAM_USAGE.prompt_tokens);
    expect(generation.completionTokens).toBe(STREAM_USAGE.completion_tokens);
  });

  it('applies the request rate limit to the external leg', async () => {
    const response = await chat(endpoint.modelId).expect(200);

    // The four-bucket limiter sits above the seam, so it charges this request the
    // same way it charges a built-in one.
    expect(response.headers['x-ratelimit-limit']).toBeDefined();
    expect(Number(response.headers['x-ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
  });
});

describe('an external endpoint with no verdict admitting it', () => {
  it('refuses with 503 attestation_failed and sends nothing upstream', async () => {
    const endpoint = await register('pending-cloud', { status: 'pending', admitted: false });

    const response = await chat(endpoint.modelId).expect(503);

    expect(response.body.error).toMatchObject({ type: 'gatekeeper_error', code: 'attestation_failed' });
    expect(response.body.error.message).toContain('pending-cloud');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(sidecar.requests.filter((entry) => entry.endpoint === endpoint.name)).toEqual([]);
  });

  it('names the stage and reason of a denial', async () => {
    const endpoint = await register('denied-cloud', { status: 'pending', admitted: false });
    await dataSource()
      .getRepository(ExternalEndpoint)
      .update({ id: endpoint.id }, { status: 'denied', lastStage: 'policy', lastReason: 'measurement not trusted' });
    await harness.app.get(ExternalCatalogService).refresh();

    const response = await chat(endpoint.modelId).expect(503);

    expect(response.body.error.message).toContain('at stage policy');
    expect(response.body.error.message).toContain('measurement not trusted');
  });

  it('is absent from /v1/models and from GET /v1/models/{id}', async () => {
    const endpoint = await register('invisible-cloud', { status: 'pending', admitted: false });

    expect((await models()).body.data.map((model) => model.id)).not.toContain(endpoint.modelId);
    await request(harness.app.getHttpServer()).get(`/v1/models/${endpoint.modelId}`).set(bearer(secret)).expect(404);
  });

  it('meters nothing: the refusal happens before a generation exists', async () => {
    const endpoint = await register('unmetered-cloud', { status: 'pending', admitted: false });
    const before = await dataSource().getRepository(Generation).count();

    await chat(endpoint.modelId).expect(503);

    // The same place `model_not_found` is decided — admission, before the meter
    // opens. A refusal that cost nothing is not a generation.
    expect(await dataSource().getRepository(Generation).count()).toBe(before);
  });
});

describe('a verdict the sidecar withdrew before router-api saw it', () => {
  it('is refused by the sidecar, and the 503 keeps the router’s own vocabulary', async () => {
    // The window between a verdict flip and the status poll that projects it. The
    // catalogue still admits the model; the sidecar does not, and fail-closed wins.
    const endpoint = await register('racing-cloud');
    sidecar.withdraw(endpoint.name, 'the trust list no longer admits this measurement');

    const response = await chat(endpoint.modelId).expect(503);

    expect(response.body.error).toMatchObject({ type: 'gatekeeper_error', code: 'attestation_failed' });
    expect(response.body.error.message).toContain('the trust list no longer admits this measurement');
  });

  it('meters the refused request as an error that cost nothing', async () => {
    const endpoint = await register('racing-metered-cloud');
    sidecar.withdraw(endpoint.name);
    const before = await dataSource().getRepository(Generation).count();

    await chat(endpoint.modelId).expect(503);

    // Unlike the admission refusal, this request reached the forward path, so the
    // Logs screen has a row for it — with a cost of zero.
    const rows = await dataSource().getRepository(Generation).count();
    expect(rows).toBe(before + 1);
    const latest = await dataSource()
      .getRepository(Generation)
      .findOne({ where: { externalEndpointId: endpoint.id }, order: { createdAt: 'DESC' } });
    expect(latest).toMatchObject({ status: 'error', errorCode: 'attestation_failed', costMicros: 0 });
  });
});

describe('a verdict withdrawn mid-stream', () => {
  it('aborts the stream, names attestation_revoked and meters it as an abort', async () => {
    // Denis's ruling 5 on SUP-221: the stream dies, the client sees policy rather
    // than flakiness, and the tokens already delivered are still metered.
    const endpoint = await register('flipping-cloud', { behaviour: 'drop-mid-stream' });

    const { response, events, chunks } = await streamed(endpoint.modelId);
    const generationId = response.headers.get('x-confidential-router-generation-id') as string;

    expect(response.status).toBe(200);
    expect(chunks.length).toBeGreaterThan(0);
    const terminal = chunks.at(-1) as { error?: { type?: string; code?: string; message?: string } };
    expect(terminal.error).toMatchObject({ type: 'gatekeeper_error', code: 'attestation_revoked' });
    expect(terminal.error?.message).toContain('measurement is not on the trust list');
    expect(events.at(-1)).toBe('data: [DONE]\n\n');

    const generation = await generationOf(generationId);
    expect(generation).toMatchObject({
      status: 'aborted',
      errorCode: 'attestation_revoked',
      externalEndpointId: endpoint.id,
    });
  });
});

describe('the status projection', () => {
  it('drops the model as soon as a withdrawn verdict is read back', async () => {
    const endpoint = await register('revocable-cloud');
    expect((await models()).body.data.map((model) => model.id)).toContain(endpoint.modelId);

    sidecar.withdraw(endpoint.name, 'the measurement was removed from the trust list');
    await harness.app.get(ExternalEndpointStatusService).sync();

    expect((await models()).body.data.map((model) => model.id)).not.toContain(endpoint.modelId);
    const refused = await chat(endpoint.modelId).expect(503);
    expect(refused.body.error.code).toBe('attestation_failed');
    expect((await dataSource().getRepository(ExternalEndpoint).findOneByOrFail({ id: endpoint.id })).status).toBe(
      'denied',
    );
  });

  it('brings the model back when a later verdict admits it again', async () => {
    const endpoint = await register('recovering-cloud', { admitted: false, status: 'pending' });
    expect((await models()).body.data.map((model) => model.id)).not.toContain(endpoint.modelId);

    sidecar.admit(endpoint.name, { evidenceDigest: UPSTREAM_DIGEST });
    await harness.app.get(ExternalEndpointStatusService).sync();

    expect((await models()).body.data.map((model) => model.id)).toContain(endpoint.modelId);
    await chat(endpoint.modelId).expect(200);
  });
});

describe('the built-in leg', () => {
  it('is untouched by any of this', async () => {
    const response = await chat('mock/chat:tdx').expect(200);

    expect(litellm.requests).toHaveLength(1);
    expect(litellm.requests[0].body.model).toBe('mock/chat');
    // LiteLLM still gets the generation-correlation header; an external operator
    // deliberately does not.
    expect(litellm.requests[0].metadata).toContain(response.body.id);

    const generation = await generationOf(response.body.id);
    expect(generation.externalEndpointId).toBeNull();
    expect(generation.endpointId).not.toBeNull();
  });
});
