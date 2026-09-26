import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource, seedCatalog, testConfig } from '../../../test/seed.js';
import { ModelRequest } from '../db/entities/model-request.entity.js';
import { ModelRequestRateLimitedError } from './model-requests.errors.js';
import { ModelRequestsService } from './model-requests.service.js';

let dataSource: DataSource;
let requests: ModelRequestsService;
let workspaceId: string;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  requests = new ModelRequestsService(dataSource, testConfig());
  workspaceId = (await seedCatalog(dataSource)).workspaceId;
});

afterEach(async () => {
  await dataSource.destroy();
});

/** One request, with everything optional defaulted. */
function ask(model: string, overrides: Partial<Parameters<ModelRequestsService['record']>[0]> = {}) {
  return requests.record({
    userId: randomUUID(),
    workspaceId,
    requestedModel: model,
    note: null,
    notify: false,
    source: 'models_page',
    ...overrides,
  });
}

/** Moves a row back in time, so a rolling window can be tested without waiting. */
async function backdate(id: string, createdAt: Date): Promise<void> {
  await dataSource.getRepository(ModelRequest).update({ id }, { createdAt });
}

describe('recording a request', () => {
  it('keeps the spelling the requester typed alongside the key it groups under', async () => {
    const recorded = await ask('  https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct  ');

    expect(recorded.requestedModel).toBe('https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct');
    expect(recorded.normalisedModel).toBe('meta-llama/llama-3.3-70b-instruct');
  });

  it('stores a note only when one was written', async () => {
    expect((await ask('qwen3-235b', { note: '   ' })).note).toBeNull();
    expect((await ask('qwen3-235b', { note: '  agentic tool use  ' })).note).toBe('agentic tool use');
  });

  it('files a second ask for the same model as a second row — the count is the signal', async () => {
    const userId = randomUUID();
    await ask('kimi-k2', { userId });
    await ask('Kimi K2', { userId });

    expect(await dataSource.getRepository(ModelRequest).count()).toBe(2);
  });
});

describe('the per-account budget', () => {
  it('refuses the request after the day’s allowance, and writes nothing', async () => {
    requests = new ModelRequestsService(dataSource, testConfig({ CR_API_MODEL_REQUESTS__PER_ACCOUNT_PER_DAY: '2' }));
    const userId = randomUUID();

    await ask('one', { userId });
    await ask('two', { userId });

    await expect(ask('three', { userId })).rejects.toBeInstanceOf(ModelRequestRateLimitedError);
    expect(await dataSource.getRepository(ModelRequest).countBy({ userId })).toBe(2);
  });

  it('is per account, not per deployment', async () => {
    requests = new ModelRequestsService(dataSource, testConfig({ CR_API_MODEL_REQUESTS__PER_ACCOUNT_PER_DAY: '1' }));

    await ask('one');
    await expect(ask('two')).resolves.toBeDefined();
  });

  it('rolls: a request made more than a day ago no longer counts against it', async () => {
    requests = new ModelRequestsService(dataSource, testConfig({ CR_API_MODEL_REQUESTS__PER_ACCOUNT_PER_DAY: '1' }));
    const userId = randomUUID();

    const first = await ask('yesterday', { userId });
    await expect(ask('today', { userId })).rejects.toBeInstanceOf(ModelRequestRateLimitedError);

    await backdate(first.id, new Date(Date.now() - 25 * 60 * 60 * 1000));

    await expect(ask('today', { userId })).resolves.toBeDefined();
  });
});

describe('the demand aggregation', () => {
  it('groups the spellings of one model and counts requests apart from requesters', async () => {
    const enthusiast = randomUUID();
    await ask('meta-llama/Llama-3.3-70B-Instruct', { userId: enthusiast });
    await ask('hf.co/meta-llama/llama-3.3-70b-instruct', { userId: enthusiast, notify: true });
    await ask('https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct', { notify: true });
    await ask('qwen3-235b');

    const [llama, qwen] = await requests.demand();

    expect(llama).toMatchObject({
      normalisedModel: 'meta-llama/llama-3.3-70b-instruct',
      requests: 3,
      requesters: 2,
      notifyRequests: 2,
    });
    expect(qwen).toMatchObject({ normalisedModel: 'qwen3-235b', requests: 1, requesters: 1, notifyRequests: 0 });
  });

  it('shows the most recent spelling, not whichever one sorts first', async () => {
    // The older spelling is the one `MAX(requestedModel)` would pick, so an
    // answer of 'GPT-OSS-120B' can only have come from the newest row.
    const older = await ask('gpt-oss-120b');
    await backdate(older.id, new Date(Date.now() - 60_000));
    await ask('GPT-OSS-120B');

    const [demand] = await requests.demand();

    expect(demand.normalisedModel).toBe('gpt-oss-120b');
    expect(demand.requestedModel).toBe('GPT-OSS-120B');
  });

  it('picks the newest spelling by id when two rows share a millisecond', async () => {
    const at = new Date('2026-09-26T00:00:00.000Z');
    const first = await ask('kimi-k2');
    const second = await ask('KIMI-K2');
    await backdate(first.id, at);
    await backdate(second.id, at);

    // Whichever id sorts last wins, but it wins every time — the answer must not
    // depend on the plan.
    const expected = first.id > second.id ? 'kimi-k2' : 'KIMI-K2';
    expect((await requests.demand())[0].requestedModel).toBe(expected);
    expect((await requests.demand())[0].requestedModel).toBe(expected);
  });

  it('orders by demand, breaking ties on the name so the table does not reshuffle', async () => {
    await ask('b-model');
    await ask('a-model');
    await ask('c-model');
    await ask('c-model');

    expect((await requests.demand()).map((entry) => entry.normalisedModel)).toEqual(['c-model', 'a-model', 'b-model']);
  });

  it('caps the list and narrows the window when asked', async () => {
    const old = await ask('last-quarter');
    await backdate(old.id, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
    await ask('this-week');

    expect((await requests.demand({ limit: 1 })).map((entry) => entry.normalisedModel)).toEqual(['last-quarter']);
    expect(
      (await requests.demand({ since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) })).map(
        (entry) => entry.normalisedModel,
      ),
    ).toEqual(['this-week']);
  });

  it('answers an empty table with an empty list rather than a row of nulls', async () => {
    expect(await requests.demand()).toEqual([]);
  });
});
