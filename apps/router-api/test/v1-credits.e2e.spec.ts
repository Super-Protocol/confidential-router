import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerCreditsGateway } from '../src/app/billing/index.js';
import { CreditTransaction } from '../src/app/db/entities/credit-transaction.entity.js';
import { Generation } from '../src/app/db/entities/generation.entity.js';
import { Workspace } from '../src/app/db/entities/workspace.entity.js';
import { CREDITS_GATEWAY, type CreditsGateway } from '../src/app/metering/credits.gateway.js';
import { createHarness, type Harness } from './app-harness.js';
import { bearer, createKey, routerConfigFor, seedWorkspace } from './gateway-fixture.js';
import { MockLiteLlm } from './mock-litellm.js';

/**
 * Where the `/v1` gateway meets the ledger.
 *
 * SUP-73 shipped `CREDITS_GATEWAY` with a placeholder that read the balance and
 * threw the debit away; this asserts the swap: a served generation writes a
 * `usage` row, the cached balance moves with it, and admission is decided by
 * what the ledger says.
 */

const START_BALANCE = 10_000_000;
const CHAT = { model: 'mock/chat:tdx', messages: [{ role: 'user', content: 'Hello there' }] };

const upstream = new MockLiteLlm();

let harness: Harness;
let secret: string;
let workspaceId: string;

beforeAll(async () => {
  const baseUrl = await upstream.start();
  harness = await createHarness({ config: routerConfigFor(baseUrl) });
  workspaceId = (await seedWorkspace(harness.app, START_BALANCE)).id;
  secret = (await createKey(harness.app, workspaceId)).secret;
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await upstream.stop();
});

function dataSource(): DataSource {
  return harness.app.get(DataSource);
}

function ledgerRows(): Promise<CreditTransaction[]> {
  return dataSource().getRepository(CreditTransaction).findBy({ workspaceId });
}

async function balance(): Promise<number> {
  return (await dataSource().getRepository(Workspace).findOneByOrFail({ id: workspaceId })).balanceMicros;
}

async function chat(): Promise<string> {
  const response = await request(harness.app.getHttpServer())
    .post('/v1/chat/completions')
    .set(bearer(secret))
    .send(CHAT)
    .expect(200);
  return response.body.id;
}

describe('a served generation', () => {
  it('writes one usage entry referencing it, and moves the balance by its cost', async () => {
    const generationId = await chat();

    const generation = await dataSource().getRepository(Generation).findOneByOrFail({ id: generationId });
    const entries = await ledgerRows();

    expect(generation.costMicros).toBeGreaterThan(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'usage',
      amountMicros: -generation.costMicros,
      reference: generationId,
    });
    expect(await balance()).toBe(START_BALANCE - generation.costMicros);
  });

  it('keeps the cached balance equal to the sum of the ledger', async () => {
    await chat();

    const entries = await ledgerRows();
    expect(await balance()).toBe(START_BALANCE + entries.reduce((sum, entry) => sum + entry.amountMicros, 0));
  });

  it('is debited once however often metering retries', async () => {
    const generationId = await chat();
    const before = await balance();
    const gateway = harness.app.get<CreditsGateway>(CREDITS_GATEWAY);

    await gateway.debit({ workspaceId, generationId, amountMicros: 1_000_000 });
    await gateway.debit({ workspaceId, generationId, amountMicros: 1_000_000 });

    expect(await balance()).toBe(before);
    expect((await ledgerRows()).filter((entry) => entry.reference === generationId)).toHaveLength(1);
  });

  it('is the ledger that answers, not the placeholder', () => {
    expect(harness.app.get(CREDITS_GATEWAY)).toBeInstanceOf(LedgerCreditsGateway);
  });
});

describe('admission', () => {
  it('refuses the next request once the ledger says the credit is gone', async () => {
    await dataSource().getRepository(Workspace).update({ id: workspaceId }, { balanceMicros: 0 });

    const response = await request(harness.app.getHttpServer())
      .post('/v1/chat/completions')
      .set(bearer(secret))
      .send(CHAT)
      .expect(402);

    expect(response.body.error.code).toBe('insufficient_credits');
  });
});
