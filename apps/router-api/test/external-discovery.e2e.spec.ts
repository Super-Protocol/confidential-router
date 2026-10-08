import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExternalEndpoint } from '../src/app/db/entities/external-endpoint.entity.js';
import { createHarness, type Harness } from './app-harness.js';
import { type ConsoleSession, graphql, signIn } from './console.js';
import { MockEgressSidecar } from './mock-sidecar.js';

/**
 * Model discovery: paste a URL and a key, let the router attest, then list
 * (SUP-249).
 *
 * The order is the property: the endpoint is registered with no models, the
 * verdict comes back, and only then does the router send its first request —
 * `GET /v1/models` through the same attested listener the egress leg uses,
 * with the stored key injected by router-api. Before the verdict, nothing is
 * sent at all, and the sidecar's request log is how that is asserted.
 *
 * The sidecar's verdict is simulated on the row (and its listener is a mock on
 * an ephemeral port), because what the sidecar does on the far side of the seam
 * is the gatekeeper suite's to test, not this one's.
 */

const OPERATOR = 'ops@example.test';
const MEMBER = 'member@example.test';
const UPSTREAM_KEY = 'sk-upstream-discovery-0123456789';
const NAME = 'partner-llama';

const REGISTER = `
  mutation Register($input: RegisterExternalEndpointInput!) {
    registerExternalEndpoint(input: $input) { id status models { id } }
  }
`;
const DISCOVER = `
  query Discover($id: ID!) {
    discoverExternalModels(id: $id) {
      upstreamModel name contextLength promptPer1mMicros completionPer1mMicros registeredAs
    }
  }
`;
const UPDATE = `
  mutation Update($id: ID!, $input: UpdateExternalEndpointInput!) {
    updateExternalEndpoint(id: $id, input: $input) { id models { id upstreamModel } }
  }
`;

const sidecar = new MockEgressSidecar();
let harness: Harness;
let dir: string;
let listenPort: number;

beforeAll(async () => {
  listenPort = await sidecar.listener(NAME);
});

afterAll(async () => {
  await sidecar.stop();
});

beforeEach(async () => {
  sidecar.reset();
  sidecar.behaviour.clear();
  sidecar.modelLists.clear();
  sidecar.modelListAnswers.clear();
  dir = mkdtempSync(join(tmpdir(), 'cr-discovery-'));
  harness = await createHarness({
    env: {
      CR_API_AUTH__ADMIN_EMAILS: OPERATOR,
      CR_API_SECRETS_KEY: Buffer.alloc(32, 5).toString('base64url'),
      CR_API_EXTERNAL_ENDPOINTS__CONFIG_FILE: join(dir, 'gatekeeper', 'config.yaml'),
      CR_API_EXTERNAL_ENDPOINTS__STATUS_POLL_INTERVAL: '0ms',
    },
  });
});

afterEach(async () => {
  await harness?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Registers with no models, and points the row at the mock listener. */
async function registerBare(session: ConsoleSession): Promise<string> {
  const body = await graphql(session, REGISTER, {
    input: { name: NAME, baseUrl: 'https://llama.partner.example/v1', apiKey: UPSTREAM_KEY, models: [] },
  });
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  expect(body.data.registerExternalEndpoint).toMatchObject({ status: 'PENDING', models: [] });
  const id = body.data.registerExternalEndpoint.id as string;
  await endpoints().update({ id }, { listenPort });
  return id;
}

/** What a verdict admitting it does to the row (`ExternalEndpointStatusService`). */
async function verdictArrives(id: string): Promise<void> {
  await endpoints().update({ id }, { status: 'verified', lastCheckedAt: new Date() });
}

function endpoints() {
  return harness.app.get(DataSource).getRepository(ExternalEndpoint);
}

describe('discoverExternalModels', () => {
  it('sends nothing upstream before the verdict, and says why', async () => {
    const id = await registerBare(await signIn(harness, OPERATOR));

    const body = await graphql(await signIn(harness, OPERATOR), DISCOVER, { id });

    expect(body.errors?.[0]?.extensions?.code).toBe('CONFLICT');
    expect(body.errors?.[0]?.message).toMatch(/not verified by this router yet/);
    expect(sidecar.requests).toEqual([]);
  });

  it('lists what the attested upstream serves, through the listener, with the stored key', async () => {
    const session = await signIn(harness, OPERATOR);
    const id = await registerBare(session);
    await verdictArrives(id);
    sidecar.modelLists.set(NAME, [
      // A Confidential Router upstream publishes context and prices…
      {
        id: 'meta/llama-3.3-70b',
        name: 'Llama 3.3 70B',
        context_length: 131072,
        pricing: { prompt_per_1m_micros: 400000, completion_per_1m_micros: 800000 },
      },
      // …a bare vLLM only its max_model_len.
      { id: 'qwen2.5-7b', object: 'model', max_model_len: 32768 },
    ]);

    const body = await graphql(session, DISCOVER, { id });

    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
    expect(body.data.discoverExternalModels).toEqual([
      {
        upstreamModel: 'meta/llama-3.3-70b',
        name: 'Llama 3.3 70B',
        contextLength: 131072,
        promptPer1mMicros: '400000',
        completionPer1mMicros: '800000',
        registeredAs: null,
      },
      {
        upstreamModel: 'qwen2.5-7b',
        name: null,
        contextLength: 32768,
        promptPer1mMicros: null,
        completionPer1mMicros: null,
        registeredAs: null,
      },
    ]);
    expect(sidecar.requests).toHaveLength(1);
    expect(sidecar.requests[0]).toMatchObject({ path: '/v1/models', authorization: `Bearer ${UPSTREAM_KEY}` });
    // The key went out on the wire to the attested listener — and comes back in no response.
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_KEY);
  });

  it('closes the loop: the ticked model registers, and the next discovery says so', async () => {
    const session = await signIn(harness, OPERATOR);
    const id = await registerBare(session);
    await verdictArrives(id);
    sidecar.modelLists.set(NAME, [{ id: 'qwen2.5-7b' }]);

    const updated = await graphql(session, UPDATE, {
      id,
      input: {
        models: [
          {
            id: 'partner/qwen2.5-7b',
            name: 'Qwen 2.5 7B',
            upstreamModel: 'qwen2.5-7b',
            contextLength: 32768,
            promptPer1mMicros: '100000',
            completionPer1mMicros: '200000',
          },
        ],
      },
    });
    expect(updated.errors, JSON.stringify(updated.errors)).toBeUndefined();

    const body = await graphql(session, DISCOVER, { id });
    expect(body.data.discoverExternalModels).toEqual([
      expect.objectContaining({ upstreamModel: 'qwen2.5-7b', registeredAs: 'partner/qwen2.5-7b' }),
    ]);
  });

  it('carries the sidecar’s fail-closed refusal through, rather than a blank list', async () => {
    const session = await signIn(harness, OPERATOR);
    const id = await registerBare(session);
    await verdictArrives(id);
    sidecar.withdraw(NAME, 'measurement is not on the trust list');

    const body = await graphql(session, DISCOVER, { id });

    expect(body.errors?.[0]?.extensions?.code).toBe('CONFLICT');
    expect(body.errors?.[0]?.message).toMatch(/egress refused .*measurement is not on the trust list/);
  });

  it('tells a rejected key apart from an upstream with no model list', async () => {
    const session = await signIn(harness, OPERATOR);
    const id = await registerBare(session);
    await verdictArrives(id);

    sidecar.modelListAnswers.set(NAME, { status: 401, body: '{"error":{"message":"bad key"}}' });
    expect((await graphql(session, DISCOVER, { id })).errors?.[0]?.message).toMatch(/refused the stored API key/);

    sidecar.modelListAnswers.set(NAME, { status: 404, body: 'not found' });
    expect((await graphql(session, DISCOVER, { id })).errors?.[0]?.message).toMatch(/Enter its models by hand/);
  });

  it('stops reading a list too large to be one, rather than buffering it', async () => {
    const session = await signIn(harness, OPERATOR);
    const id = await registerBare(session);
    await verdictArrives(id);
    sidecar.modelListAnswers.set(NAME, { status: 200, body: `{"data":[${'{"id":"x"},'.repeat(300_000)}]}` });

    const body = await graphql(session, DISCOVER, { id });

    expect(body.errors?.[0]?.extensions?.code).toBe('CONFLICT');
    expect(body.errors?.[0]?.message).toMatch(/more than 2 MB/);
  });

  it('is an operator call: it spends the stored key', async () => {
    const id = await registerBare(await signIn(harness, OPERATOR));
    await verdictArrives(id);

    const body = await graphql(await signIn(harness, MEMBER), DISCOVER, { id });

    expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(sidecar.requests).toEqual([]);
  });
});
