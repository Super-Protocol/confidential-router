/**
 * The console's own path: sign in, top up, mint a key, spend it, read it back.
 *
 * Every step goes through the API the browser calls, in the order a person
 * does them, against the built router over HTTP. What it is really testing is
 * that the surfaces join up — that money moved by the Credits screen is money
 * the gateway will spend, and that a generation the gateway metered is the one
 * the Activity screen shows.
 */
import { delay, type RouterStack, startRouterStack } from '@confidential-router/demo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DEMO_MODEL = 'meta/llama-3.3-70b-instruct:tdx';
const METERING_TIMEOUT_MS = 20_000;

let stack: RouterStack;

beforeAll(async () => {
  stack = await startRouterStack();
});

afterAll(async () => {
  await stack?.stop();
});

async function balanceMicros(): Promise<number> {
  const data = await stack.session.graphql<{ creditBalance: { balanceMicros: string; spendable: boolean } }>(
    'query Balance($workspaceId: ID!) { creditBalance(workspaceId: $workspaceId) { balanceMicros spendable } }',
    { workspaceId: stack.session.workspaceId },
  );
  return Number(data.creditBalance.balanceMicros);
}

interface GenerationNode {
  id: string;
  status: string;
  costMicros: string;
  promptTokens: number;
  completionTokens: number;
  modelId: string;
  apiKeyName: string | null;
  streamed: boolean;
}

async function generations(): Promise<GenerationNode[]> {
  const data = await stack.session.graphql<{ generations: { edges: { node: GenerationNode }[] } }>(
    `query Generations($workspaceId: ID!) {
       generations(workspaceId: $workspaceId, first: 50) {
         edges { node { id status costMicros promptTokens completionTokens modelId apiKeyName streamed } }
       }
     }`,
    { workspaceId: stack.session.workspaceId },
  );
  return data.generations.edges.map((edge) => edge.node);
}

async function waitForGenerations(atLeast: number): Promise<GenerationNode[]> {
  const deadline = Date.now() + METERING_TIMEOUT_MS;
  for (;;) {
    const all = await generations();
    if (all.length >= atLeast) {
      return all;
    }
    if (Date.now() > deadline) {
      throw new Error(`the console reports ${all.length} generation(s), expected at least ${atLeast}`);
    }
    await delay(250);
  }
}

async function chat(content: string, stream = false): Promise<Response> {
  return fetch(`${stack.router.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${stack.credential.secret}` },
    body: JSON.stringify({ model: DEMO_MODEL, messages: [{ role: 'user', content }], stream }),
  });
}

describe('the console and the gateway, over the same workspace', () => {
  it('signed a user in and gave them a workspace with the credits they bought', async () => {
    expect(stack.session.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await balanceMicros()).toBe(20_000_000);
  });

  it('shows a key the console minted, without ever showing its secret again', async () => {
    const data = await stack.session.graphql<{ apiKeys: { id: string; name: string; prefix: string }[] }>(
      'query Keys($workspaceId: ID!) { apiKeys(workspaceId: $workspaceId) { id name prefix } }',
      { workspaceId: stack.session.workspaceId },
    );

    const key = data.apiKeys.find((candidate) => candidate.id === stack.credential.id);
    expect(key?.name).toBe('Demo key');
    expect(key?.prefix).toBe(stack.credential.secret.slice(0, 12));
    expect(JSON.stringify(data)).not.toContain(stack.credential.secret);
  });

  it('meters a generation and debits it from the balance that paid for it', async () => {
    const before = await balanceMicros();
    const beforeCount = (await generations()).length;

    const response = await chat('Charge me for this');
    expect(response.status).toBe(200);

    const metered = await waitForGenerations(beforeCount + 1);
    const latest = metered[0];
    expect(latest.status).toBe('OK');
    expect(latest.modelId).toBe(DEMO_MODEL);
    expect(latest.apiKeyName).toBe('Demo key');
    expect(latest.promptTokens).toBeGreaterThan(0);
    expect(latest.completionTokens).toBeGreaterThan(0);

    const after = await balanceMicros();
    expect(before - after).toBe(Number(latest.costMicros));
  });

  it('meters a streamed generation with its own token counts', async () => {
    const beforeCount = (await generations()).length;

    const response = await chat('Stream and charge me', true);
    expect(response.status).toBe(200);
    await response.text();

    const metered = await waitForGenerations(beforeCount + 1);
    const streamed = metered.find((generation) => generation.streamed);
    expect(streamed).toBeDefined();
    expect(streamed?.completionTokens).toBeGreaterThan(0);
  });

  it('records the purchase and the usage in one ledger', async () => {
    await waitForGenerations(1);

    const data = await stack.session.graphql<{
      creditTransactions: { edges: { node: { kind: string; amountMicros: string } }[] };
    }>(
      'query Ledger($workspaceId: ID!) { creditTransactions(workspaceId: $workspaceId, first: 50) ' +
        '{ edges { node { kind amountMicros } } } }',
      { workspaceId: stack.session.workspaceId },
    );

    const entries = data.creditTransactions.edges.map((edge) => edge.node);
    expect(entries.some((entry) => entry.kind === 'PURCHASE' && Number(entry.amountMicros) > 0)).toBe(true);
    expect(entries.some((entry) => entry.kind === 'USAGE' && Number(entry.amountMicros) < 0)).toBe(true);
  });

  it('refuses an anonymous GraphQL query for a workspace', async () => {
    const response = await fetch(`${stack.router.baseUrl}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stack.session.origin },
      body: JSON.stringify({
        query: 'query Keys($workspaceId: ID!) { apiKeys(workspaceId: $workspaceId) { id } }',
        variables: { workspaceId: stack.session.workspaceId },
      }),
    });

    const body = (await response.json()) as { data?: unknown; errors?: unknown[] };
    expect(body.errors?.length).toBeGreaterThan(0);
  });
});
