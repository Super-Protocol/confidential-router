import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './app-harness.js';
import { anonymous, type ConsoleSession, expectData, graphql, signIn } from './console.js';

/**
 * "Request a model", end to end: the dialog's write, the operator's
 * aggregation, and the CSV an operator opens in a spreadsheet.
 *
 * The three are one feature and are tested as one, because what the screens
 * promise is that the number in the export is the number the requests add up
 * to. Everything here boots the real application: the guards on the admin
 * surface, the analytics capture and the per-account budget are all wiring, and
 * wiring is the part a unit test cannot see.
 */

const OPERATOR = 'ops@example.com';

const REQUEST_MODEL = `
  mutation RequestModel($input: RequestModelInput!) {
    requestModel(input: $input) { id requestedModel notify createdAt }
  }
`;

const DEMAND = `
  query Demand($limit: Int) {
    modelDemand(limit: $limit) { model normalisedModel requests requesters notifyRequests }
  }
`;

let harness: Harness;

afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as Harness;
});

async function modelRequestHarness(env: Record<string, string> = {}): Promise<Harness> {
  harness = await createHarness({ env: { CR_API_AUTH__ADMIN_EMAILS: OPERATOR, ...env } });
  return harness;
}

function ask(session: ConsoleSession, model: string, input: Record<string, unknown> = {}) {
  return graphql(session, REQUEST_MODEL, { input: { model, source: 'MODELS_PAGE', ...input } });
}

/** The export, as the browser fetches it: a plain GET carrying the session cookie. */
function exportCsv(session: ConsoleSession) {
  return request(session.harness.app.getHttpServer())
    .get('/admin/model-requests/demand.csv')
    .set('Cookie', session.cookies);
}

describe('filing a request', () => {
  it('confirms what it stored, so the dialog can say so rather than guess', async () => {
    await modelRequestHarness();
    const user = await signIn(harness, 'dev@example.com');

    const receipt = (
      await expectData(user, REQUEST_MODEL, {
        input: {
          model: '  https://huggingface.co/moonshotai/Kimi-K2-Instruct  ',
          note: 'long-context agentic runs',
          notify: true,
          source: 'EMPTY_STATE',
        },
      })
    ).requestModel;

    expect(receipt).toMatchObject({
      requestedModel: 'https://huggingface.co/moonshotai/Kimi-K2-Instruct',
      notify: true,
    });
    expect(receipt.id).toEqual(expect.any(String));
  });

  it('reports `model_requested` with the screen and whether a note was written — and never the name', async () => {
    await modelRequestHarness();
    const user = await signIn(harness, 'dev@example.com');

    await expectData(user, REQUEST_MODEL, {
      input: { model: 'kimi-k2', note: 'agentic runs', source: 'EMPTY_STATE' },
    });

    const event = harness.events.one('model_requested');
    expect(event.properties).toEqual({ source: 'empty_state', has_details: true });
    // The taxonomy's one hard rule: no free text leaves the database.
    expect(JSON.stringify(event)).not.toContain('agentic runs');
    expect(JSON.stringify(event)).not.toContain('kimi-k2');
  });

  it('refuses an anonymous caller', async () => {
    await modelRequestHarness();

    const refused = await ask(anonymous(harness), 'kimi-k2');

    expect(refused.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a name that is only whitespace — it would group under an empty key', async () => {
    await modelRequestHarness();
    const user = await signIn(harness, 'dev@example.com');
    const operator = await signIn(harness, OPERATOR);

    expect((await ask(user, '   ')).errors?.[0].extensions.code).toBe('BAD_REQUEST');
    expect((await expectData(operator, DEMAND)).modelDemand).toEqual([]);
  });

  it('refuses an empty name, and a note longer than the column', async () => {
    await modelRequestHarness();
    const user = await signIn(harness, 'dev@example.com');

    // `BAD_REQUEST` and not `BAD_USER_INPUT`: the global `ValidationPipe` runs
    // before the resolver, so Apollo has already coded the error and
    // `formatConsoleError` keeps Apollo's own codes as they are.
    expect((await ask(user, '')).errors?.[0].extensions.code).toBe('BAD_REQUEST');
    expect((await ask(user, 'kimi-k2', { note: 'x'.repeat(2001) })).errors?.[0].extensions.code).toBe('BAD_REQUEST');
  });

  it('stops one account from drowning the count, without losing what it already said', async () => {
    await modelRequestHarness({ CR_API_MODEL_REQUESTS__PER_ACCOUNT_PER_DAY: '2' });
    const user = await signIn(harness, 'keen@example.com');
    const operator = await signIn(harness, OPERATOR);

    await expectData(user, REQUEST_MODEL, { input: { model: 'kimi-k2', source: 'MODELS_PAGE' } });
    await expectData(user, REQUEST_MODEL, { input: { model: 'qwen3-235b', source: 'MODELS_PAGE' } });
    const refused = await ask(user, 'deepseek-v3');

    expect(refused.errors?.[0].extensions.code).toBe('TOO_MANY_REQUESTS');
    const demand = (await expectData(operator, DEMAND)).modelDemand;
    expect(demand.map((entry: { normalisedModel: string }) => entry.normalisedModel)).toEqual([
      'kimi-k2',
      'qwen3-235b',
    ]);
  });
});

describe('the admin aggregation', () => {
  it('adds the same model up across accounts and spellings, and tells requests from requesters', async () => {
    await modelRequestHarness();
    const operator = await signIn(harness, OPERATOR);
    const first = await signIn(harness, 'first@example.com');
    const second = await signIn(harness, 'second@example.com');

    await ask(first, 'moonshotai/Kimi-K2-Instruct', { notify: true });
    await ask(first, 'hf.co/moonshotai/kimi-k2-instruct');
    await ask(second, 'https://huggingface.co/moonshotai/Kimi-K2-Instruct');
    await ask(second, 'qwen3-235b-a22b');

    const demand = (await expectData(operator, DEMAND)).modelDemand;

    expect(demand).toEqual([
      {
        // The newest spelling, for a table a human reads.
        model: 'https://huggingface.co/moonshotai/Kimi-K2-Instruct',
        normalisedModel: 'moonshotai/kimi-k2-instruct',
        requests: 3,
        requesters: 2,
        notifyRequests: 1,
      },
      {
        model: 'qwen3-235b-a22b',
        normalisedModel: 'qwen3-235b-a22b',
        requests: 1,
        requesters: 1,
        notifyRequests: 0,
      },
    ]);
  });

  it('refuses a limit the database would refuse, rather than passing it through', async () => {
    await modelRequestHarness();
    const operator = await signIn(harness, OPERATOR);

    // `LIMIT -1` is "no limit" on SQLite and a syntax error on PostgreSQL.
    const refused = await graphql(operator, DEMAND, { limit: -1 });

    expect(refused.errors?.[0].extensions.code).toBe('BAD_REQUEST');
    expect(refused.errors?.[0].message).toContain('between 1 and 10000');
  });

  it('refuses a signed-in caller who is not an operator', async () => {
    await modelRequestHarness();
    const user = await signIn(harness, 'dev@example.com');

    const refused = await graphql(user, DEMAND);

    expect(refused.errors?.[0].extensions.code).toBe('FORBIDDEN');
    expect(refused.data?.modelDemand ?? null).toBeNull();
  });

  it('refuses an anonymous caller before it refuses a non-operator', async () => {
    await modelRequestHarness();

    expect((await graphql(anonymous(harness), DEMAND)).errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

describe('the CSV export', () => {
  it('opens as a spreadsheet, with the counts the aggregation reports', async () => {
    await modelRequestHarness();
    const operator = await signIn(harness, OPERATOR);
    const first = await signIn(harness, 'first@example.com');
    const second = await signIn(harness, 'second@example.com');

    await ask(first, 'Kimi K2', { notify: true });
    await ask(second, 'kimi k2');
    await ask(second, 'qwen3-235b-a22b');

    const response = await exportCsv(operator).expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('filename="model-demand.csv"');
    expect(response.headers['cache-control']).toBe('no-store');

    const rows = response.text.trimEnd().split('\r\n');
    expect(rows[0]).toBe('model,normalisedModel,requests,requesters,notifyRequests,firstRequestedAt,lastRequestedAt');
    expect(rows[1]).toMatch(/^kimi k2,kimi k2,2,2,1,/);
    expect(rows[2]).toMatch(/^qwen3-235b-a22b,qwen3-235b-a22b,1,1,0,/);
  });

  it('neutralises a name a spreadsheet would run as a formula', async () => {
    await modelRequestHarness();
    const operator = await signIn(harness, OPERATOR);
    const user = await signIn(harness, 'dev@example.com');

    await ask(user, '=HYPERLINK("http://evil.example")');

    const rows = (await exportCsv(operator).expect(200)).text.trimEnd().split('\r\n');

    expect(rows[1]).toMatch(/^"'=HYPERLINK\(""http:\/\/evil\.example""\)"/);
  });

  it('is operator-only, like the query it exports', async () => {
    await modelRequestHarness();
    const user = await signIn(harness, 'dev@example.com');

    await exportCsv(user).expect(403);
    await exportCsv(anonymous(harness)).expect(401);
  });
});
