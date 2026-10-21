import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Generation } from '../src/app/db/entities/generation.entity.js';
import { createHarness, type Harness } from './app-harness.js';
import { bearer, createKey, routerConfigFor, seedWorkspace } from './gateway-fixture.js';
import { MockLiteLlm } from './mock-litellm.js';

const upstream = new MockLiteLlm();

let harness: Harness;
let secret: string;
let workspaceId: string;
let upstreamUrl: string;

beforeAll(async () => {
  upstreamUrl = await upstream.start();
  harness = await createHarness({
    config: routerConfigFor(upstreamUrl, {
      // A `/v1` ceiling small enough for a test to cross with a string, and
      // deadlines short enough for `mock/thinking` to expire inside one.
      server: { maxInferenceRequestBytes: MAX_BODY_BYTES },
      backends: {
        litellm: { baseUrl: upstreamUrl, apiKey: 'mock-litellm-key', connectTimeout: '1s', readTimeout: '1s' },
      },
    }),
  });
  const workspace = await seedWorkspace(harness.app);
  workspaceId = workspace.id;
  secret = (await createKey(harness.app, workspaceId)).secret;
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await upstream.stop();
});

beforeEach(() => {
  upstream.reset();
});

function server() {
  return harness.app.getHttpServer();
}

function chat(model = 'mock/chat:tdx') {
  return { model, messages: [{ role: 'user', content: 'Hello there' }] };
}

/** This suite's `/v1` body ceiling: 2 MiB, twice the 1 MiB the console keeps. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** A chat body whose single message makes the request about `bytes` long. */
function chatOfSize(bytes: number) {
  return { model: 'mock/chat:tdx', messages: [{ role: 'user', content: 'x'.repeat(bytes - 128) }] };
}

/** Returns the supertest `Test` itself so callers can chain `.expect(...)`. */
function post(token: string, body: object) {
  return request(server()).post('/v1/chat/completions').set(bearer(token)).send(body);
}

describe('request validation', () => {
  it('refuses a body that is not JSON', async () => {
    const response = await request(server())
      .post('/v1/chat/completions')
      .set(bearer(secret))
      .set('Content-Type', 'application/json')
      .send('{"model": ')
      .expect(400);

    expect(response.body.error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_json' });
  });

  it('names the field it is missing', async () => {
    const response = await post(secret, { messages: [] }).expect(400);

    expect(response.body.error).toMatchObject({ code: 'missing_field', param: 'model' });
  });

  it('refuses a model the catalogue does not have', async () => {
    const response = await post(secret, chat('nobody/nothing:tdx')).expect(404);

    expect(response.body.error).toMatchObject({ code: 'model_not_found', param: 'model' });
  });

  it('refuses the parameters it cannot meter', async () => {
    const response = await post(secret, { ...chat(), n: 2 }).expect(400);

    expect(response.body.error).toMatchObject({ code: 'unsupported_parameter', param: 'n' });
  });

  it('accepts n = 1, which is what an SDK sends when it sends one at all', async () => {
    await post(secret, { ...chat(), n: 1 }).expect(200);
  });
});

/**
 * SUP-339: `/v1` used to share the console's 1 MiB parser limit, which made the
 * `context_length` the catalogue advertises a figure no client could spend — prod
 * advertises 262 144 tokens and serves them, and that is megabytes of prompt.
 */
describe('request size', () => {
  it('accepts a prompt larger than the console surfaces take', async () => {
    await post(secret, chatOfSize(1_500_000)).expect(200);
  });

  it('refuses a body over its own ceiling in the OpenAI shape, naming the ceiling', async () => {
    const response = await post(secret, chatOfSize(MAX_BODY_BYTES + 100_000)).expect(413);

    expect(response.body.error).toMatchObject({ type: 'invalid_request_error', code: 'request_too_large' });
    expect(response.body.error.message).toContain('2 MiB');
  });
});

describe('key scope', () => {
  it('refuses a model outside the key s scope, before revealing anything about it', async () => {
    const scoped = await createKey(harness.app, workspaceId, { modelScope: ['mock/scoped:tdx'] });

    const response = await post(scoped.secret, chat('mock/chat:tdx')).expect(403);

    expect(response.body.error).toMatchObject({ type: 'permission_error', code: 'model_not_in_key_scope' });
    expect(upstream.requests).toHaveLength(0);
  });

  it('serves a model inside the scope', async () => {
    const scoped = await createKey(harness.app, workspaceId, { modelScope: ['mock/scoped:tdx'] });

    await post(scoped.secret, chat('mock/scoped:tdx')).expect(200);
  });
});

describe('credits', () => {
  it('refuses a workspace with no balance', async () => {
    const broke = await seedWorkspace(harness.app, 0);
    const key = await createKey(harness.app, broke.id);

    const response = await post(key.secret, chat()).expect(402);

    expect(response.body.error).toMatchObject({ type: 'insufficient_credits', code: 'insufficient_credits' });
    expect(upstream.requests).toHaveLength(0);
  });

  it('refuses a key that has reached its own spend limit', async () => {
    // The limit is smaller than one generation, so the second call is refused.
    const limited = await createKey(harness.app, workspaceId, { spendLimitMicros: 10 });

    await post(limited.secret, chat()).expect(200);
    const response = await post(limited.secret, chat()).expect(402);

    expect(response.body.error.code).toBe('key_spend_limit_reached');
  });
});

describe('rate limits', () => {
  it('reports the remaining budget on every response', async () => {
    const response = await post(secret, chat()).expect(200);

    expect(response.headers['x-ratelimit-limit']).toBeDefined();
    expect(Number(response.headers['x-ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
    expect(Number(response.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('refuses a key over its requests-per-minute budget', async () => {
    const limited = await createKey(harness.app, workspaceId, { requestsPerMinute: 2 });

    await post(limited.secret, chat()).expect(200);
    await post(limited.secret, chat()).expect(200);
    const response = await post(limited.secret, chat()).expect(429);

    expect(response.body.error).toMatchObject({ type: 'rate_limit_error', code: 'rate_limit_exceeded' });
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect(response.headers['x-ratelimit-limit']).toBe('2');
    expect(response.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('refuses a key whose token budget the previous request exhausted', async () => {
    // One generation costs 18 tokens; the budget is 10, so it is spent by the
    // time the second request is admitted.
    const limited = await createKey(harness.app, workspaceId, { tokensPerMinute: 10 });

    await post(limited.secret, chat()).expect(200);
    const response = await post(limited.secret, chat()).expect(429);

    expect(response.body.error.code).toBe('rate_limit_exceeded');
  });
});

/**
 * Its own harness: the workspace token budget comes from `rateLimits`, which is
 * deployment configuration and cannot be varied per key.
 */
describe('the workspace token budget', () => {
  let scoped: Harness;
  let generous: string;

  beforeAll(async () => {
    scoped = await createHarness({ config: routerConfigFor(upstreamUrl, { rateLimits: { tokensPerMinute: 10 } }) });
    const workspace = await seedWorkspace(scoped.app);
    // A key with a far larger budget of its own, so only the workspace bucket
    // can refuse anything here.
    generous = (await createKey(scoped.app, workspace.id, { tokensPerMinute: 1_000_000 })).secret;
  }, 60_000);

  afterAll(async () => {
    await scoped?.close();
  });

  it('refuses a request once the previous generation spent the workspace s tokens', async () => {
    const first = await request(scoped.app.getHttpServer())
      .post('/v1/chat/completions')
      .set(bearer(generous))
      .send(chat());
    expect(first.status).toBe(200);

    const response = await request(scoped.app.getHttpServer())
      .post('/v1/chat/completions')
      .set(bearer(generous))
      .send(chat())
      .expect(429);

    expect(response.body.error).toMatchObject({ type: 'rate_limit_error', code: 'rate_limit_exceeded' });
    expect(response.body.error.message).toContain('workspace');
  });
});

describe('backend failures', () => {
  it('maps a crashed backend to 502, without blaming the caller', async () => {
    const response = await post(secret, chat('mock/boom:tdx')).expect(502);

    expect(response.body.error).toMatchObject({ type: 'upstream_error', code: 'backend_unavailable' });
  });

  it('passes a saturated backend through as a rate limit the client can retry', async () => {
    const response = await post(secret, chat('mock/overloaded:tdx')).expect(429);

    expect(response.body.error.code).toBe('rate_limit_exceeded');
    expect(response.headers['retry-after']).toBe('7');
  });

  it('maps an over-long prompt to the client-facing 400', async () => {
    const response = await post(secret, chat('mock/context:tdx')).expect(400);

    expect(response.body.error).toMatchObject({ code: 'context_length_exceeded', param: 'messages' });
    expect(response.body.error.message).toContain('maximum context length');
  });

  it('does not turn our own bad backend credential into the caller s 401', async () => {
    const response = await post(secret, chat('mock/refuses:tdx')).expect(502);

    expect(response.body.error.code).toBe('backend_error');
  });

  it('refuses a backend body it cannot parse', async () => {
    const response = await post(secret, chat('mock/garbage:tdx')).expect(502);

    expect(response.body.error.code).toBe('backend_error');
  });

  it('retries a connection that never established, exactly once', async () => {
    const response = await post(secret, chat('mock/hangup:tdx')).expect(502);

    expect(response.body.error.code).toBe('backend_unavailable');
    expect(upstream.requests).toHaveLength(2);
  });

  it('does not retry a backend that answered badly', async () => {
    await post(secret, chat('mock/boom:tdx')).expect(502);

    expect(upstream.requests).toHaveLength(1);
  });

  it('meters a failed generation at zero, so the Logs screen still shows it', async () => {
    await post(secret, chat('mock/boom:tdx')).expect(502);

    const row = await harness.app
      .get(DataSource)
      .getRepository(Generation)
      .findOneOrFail({ where: { modelId: 'mock/boom:tdx' }, order: { createdAt: 'DESC' } });
    expect(row).toMatchObject({ status: 'error', errorCode: 'backend_unavailable', costMicros: 0 });
  });

  /**
   * SUP-339: the same message used to cover a refusal the router made itself. A
   * prompt the upstream was still prefilling, and a burst it had merely queued,
   * both came back as `backend_unavailable` — sending operators to inspect a model
   * deployment that was answering the identical request fine one hop over.
   */
  it('names a backend that is slow rather than unreachable', async () => {
    const response = await post(secret, chat('mock/thinking:tdx')).expect(504);

    expect(response.body.error).toMatchObject({ type: 'upstream_error', code: 'upstream_timeout' });
    expect(response.body.error.message).not.toContain('unreachable');
    // Not retried: the socket was accepted, so the generation may be running.
    expect(upstream.requests).toHaveLength(1);
  });

  it('does not charge a refused request', async () => {
    const before = await harness.app.get(DataSource).getRepository(Generation).count();
    await post(secret, chat('nobody/nothing:tdx')).expect(404);

    expect(await harness.app.get(DataSource).getRepository(Generation).count()).toBe(before);
  });
});

/**
 * SUP-448, the conformance the issue asks for: a conversation the upstream reads
 * and calls invalid must come back as a 4xx that names the field.
 *
 * It used to be `502 backend_error`. That is "transient, retry" to every
 * OpenAI-compatible SDK — and the offending message is already in the history, so
 * each retry rebuilt the same invalid request. One client slip (Continue merging
 * two concurrent responses into a truncated `arguments`, SP-447) killed the
 * session permanently and the user read it as our outage: 15 of 97 agent requests
 * through production in one afternoon.
 */
describe('a request the model endpoint itself calls invalid', () => {
  /** The body that killed the Continue sessions: `arguments` is truncated JSON. */
  function poisoned(model = 'mock/invalid-tool-call:tdx') {
    return {
      model,
      messages: [
        { role: 'user', content: 'Read the readme' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filepath": "RE' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '# Readme' },
      ],
    };
  }

  it('comes back as a 4xx, so no SDK and no “Resubmit” retries it forever', async () => {
    const response = await post(secret, poisoned()).expect(400);

    expect(response.body.error).toMatchObject({
      type: 'invalid_request_error',
      code: 'upstream_invalid_request',
    });
    // The whole point: not the status that means "the gateway is broken, try again".
    expect(response.status).not.toBe(502);
  });

  it('names the field that is wrong, which the router itself cannot know', async () => {
    const response = await post(secret, poisoned()).expect(400);

    expect(response.body.error.message).toContain('messages[8].tool_calls[0].function.arguments');
    expect(response.body.error.param).toBe('messages[8].tool_calls[0].function.arguments');
  });

  it('is metered as an error that cost nothing, like any other refusal', async () => {
    await post(secret, poisoned()).expect(400);

    const row = await harness.app
      .get(DataSource)
      .getRepository(Generation)
      .findOneOrFail({ where: { modelId: 'mock/invalid-tool-call:tdx' }, order: { createdAt: 'DESC' } });
    expect(row).toMatchObject({ status: 'error', errorCode: 'upstream_invalid_request', costMicros: 0 });
  });

  it('is not retried upstream: the request cannot become valid on a second send', async () => {
    await post(secret, poisoned()).expect(400);

    expect(upstream.requests).toHaveLength(1);
  });
});
