import type { ConfigType } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';
import type { routerConfig } from '../../config.js';
import type { ApiKey } from '../../db/entities/api-key.entity.js';
import { OpenAiApiError } from './openai-error.js';
import { RateLimitService } from './rate-limit.service.js';
import { InMemoryTokenBucketRateLimiter } from './rate-limiter.js';

/** Workspace defaults; every test that cares overrides one of the two. */
const DEFAULTS = { requestsPerMinute: 100, tokensPerMinute: 1_000 };

let limiter: InMemoryTokenBucketRateLimiter;

function serviceWith(rateLimits: { requestsPerMinute: number; tokensPerMinute: number }): RateLimitService {
  const config = { rateLimits } as ConfigType<typeof routerConfig>;
  return new RateLimitService(config, limiter);
}

let nextKeyId = 0;

/** Just the fields `RateLimitService` reads — it never touches the row itself. */
function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  nextKeyId += 1;
  return {
    id: `key-${nextKeyId}`,
    workspaceId: 'ws-1',
    requestsPerMinute: null,
    tokensPerMinute: null,
    ...overrides,
  } as ApiKey;
}

/** The 429 the contract defines, with the scope it names in its message. */
async function refusal(call: Promise<unknown>): Promise<OpenAiApiError> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenAiApiError);
    return error as OpenAiApiError;
  }
  throw new Error('Expected the request to be refused.');
}

beforeEach(() => {
  limiter = new InMemoryTokenBucketRateLimiter();
  nextKeyId = 0;
});

describe('admit', () => {
  it('reports the tightest request budget it charged', async () => {
    const service = serviceWith({ ...DEFAULTS, requestsPerMinute: 10 });

    const grant = await service.admit(apiKey({ requestsPerMinute: 3 }));

    expect(grant.headers['X-RateLimit-Limit']).toBe('3');
    expect(grant.headers['X-RateLimit-Remaining']).toBe('2');
  });

  it('refuses a key over its own requests-per-minute budget', async () => {
    const service = serviceWith(DEFAULTS);
    const key = apiKey({ requestsPerMinute: 1 });
    await service.admit(key);

    const error = await refusal(service.admit(key));

    expect(error.code).toBe('rate_limit_exceeded');
    expect(error.message).toContain('API key');
  });

  it('refuses a workspace over its requests-per-minute budget, however many keys it mints', async () => {
    const service = serviceWith({ ...DEFAULTS, requestsPerMinute: 2 });
    // Two keys, one workspace: the workspace bucket is what stops the third
    // request, not either key's own budget.
    await service.admit(apiKey({ requestsPerMinute: 100 }));
    await service.admit(apiKey({ requestsPerMinute: 100 }));

    const error = await refusal(service.admit(apiKey({ requestsPerMinute: 100 })));

    expect(error.message).toContain('workspace');
  });

  it('refuses a key whose token budget a previous generation exhausted', async () => {
    const service = serviceWith(DEFAULTS);
    const key = apiKey({ tokensPerMinute: 10 });
    await service.admit(key);
    await service.settle(key, 18);

    const error = await refusal(service.admit(key));

    expect(error.message).toContain('API key token');
  });

  it('refuses a workspace whose token budget a previous generation exhausted', async () => {
    const service = serviceWith({ ...DEFAULTS, tokensPerMinute: 10 });
    // A key with a far larger token budget of its own: only the workspace
    // bucket can refuse here, and before this it never was consulted.
    const first = apiKey({ tokensPerMinute: 1_000_000 });
    await service.admit(first);
    await service.settle(first, 18);

    const error = await refusal(service.admit(apiKey({ tokensPerMinute: 1_000_000 })));

    expect(error.message).toContain('workspace token');
  });

  it('keeps workspaces out of each other s token budget', async () => {
    const service = serviceWith({ ...DEFAULTS, tokensPerMinute: 10 });
    const spender = apiKey({ workspaceId: 'ws-spender', tokensPerMinute: 1_000_000 });
    await service.admit(spender);
    await service.settle(spender, 18);

    await expect(service.admit(apiKey({ workspaceId: 'ws-neighbour' }))).resolves.toBeDefined();
  });

  it('admits a request whose token budget is merely low, not spent', async () => {
    const service = serviceWith({ ...DEFAULTS, tokensPerMinute: 100 });
    const key = apiKey();
    await service.admit(key);
    await service.settle(key, 99);

    // One token left is still a token: the cost is unknown until the model
    // answers, so a request may overshoot by its own size but never start on an
    // empty bucket.
    await expect(service.admit(key)).resolves.toBeDefined();
  });

  it('carries Retry-After and the rate-limit headers on a refusal', async () => {
    const service = serviceWith({ ...DEFAULTS, requestsPerMinute: 60 });
    const key = apiKey({ requestsPerMinute: 60 });
    for (let index = 0; index < 60; index += 1) {
      await service.admit(key);
    }

    const error = await refusal(service.admit(key));

    expect(Number(error.headers['Retry-After'])).toBeGreaterThan(0);
    expect(error.headers['X-RateLimit-Remaining']).toBe('0');
  });
});

describe('settle', () => {
  it('charges both scopes so neither can be evaded by the other', async () => {
    const service = serviceWith({ ...DEFAULTS, tokensPerMinute: 50 });
    const key = apiKey({ tokensPerMinute: 50 });

    await service.settle(key, 50);

    await expect(refusal(service.admit(key))).resolves.toBeDefined();
  });

  it('ignores a generation that produced nothing', async () => {
    const service = serviceWith({ ...DEFAULTS, tokensPerMinute: 1 });
    const key = apiKey();

    await service.settle(key, 0);

    await expect(service.admit(key)).resolves.toBeDefined();
  });
});
