import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './fixtures';

/** Same bar as `accessibility.spec.ts`: nothing serious or critical. */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

  return results.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(' ')) }));
}

type Responder = Record<string, unknown> | ((variables: Record<string, unknown>) => Record<string, unknown>);

/**
 * Answers the two screens' operations from fixtures.
 *
 * Registered *after* `signIn`, whose handler answers only `Session`: Playwright
 * resolves routes last-registered-first, so this one sees the request and falls
 * through to the session fixture for anything it does not know.
 */
async function mockConsole(page: Page, data: Record<string, Responder>): Promise<void> {
  await page.route('**/graphql', async (route) => {
    const body = route.request().postDataJSON() as { operationName?: string; variables?: Record<string, unknown> };
    const operation = body?.operationName ?? '';
    const handler = data[operation];

    if (handler === undefined) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: typeof handler === 'function' ? handler(body.variables ?? {}) : handler,
      }),
    });
  });
}

function summary(spendMicros: string, requests: number) {
  return {
    spendMicros,
    requests,
    promptTokens: 640_000,
    completionTokens: 160_000,
    coveredRequests: requests,
    evidenceCoverage: 1,
    avgTimeToFirstTokenMs: 312,
    avgTokensPerSecond: 48.23,
  };
}

/** `stepHours` matches the bucket the query asked for, as the real API's does. */
function series(count: number, stepHours: number) {
  const start = Date.UTC(2026, 7, 1);

  return Array.from({ length: count }, (_, index) => ({
    bucket: new Date(start + index * stepHours * 3_600_000).toISOString(),
    spendMicros: `${10_000 + index * 500}`,
    requests: 10 + index,
    promptTokens: 100 + index * 20,
    completionTokens: 40 + index * 6,
    evidenceCoverage: 1,
  }));
}

const ACTIVITY = {
  Activity: (variables: Record<string, unknown>) => {
    const hours = Math.round((Date.parse(variables.to as string) - Date.parse(variables.from as string)) / 3_600_000);

    return {
      activitySummary: hours === 24 ? summary('1234500', 842) : summary('45670000', 11_000),
      activitySeries: hours === 24 ? series(24, 1) : series(8, 24),
      topKeys: [
        {
          apiKeyId: 'key-1',
          name: 'agents-prod',
          prefix: 'sk-tee-v1-4f',
          requests: 700,
          promptTokens: 500_000,
          completionTokens: 98_000,
          spendMicros: '1000000',
        },
      ],
    };
  },
  ActivityUsageByModel: {
    usageByModel: [
      {
        modelId: 'meta/llama-3.3-70b-instruct:tdx',
        name: 'Llama 3.3 70B Instruct',
        requests: 700,
        promptTokens: 500_000,
        completionTokens: 98_000,
        spendMicros: '1000000',
        evidenceCoverage: 1,
      },
    ],
  },
};

const LOGS = {
  LogFilterOptions: {
    models: [{ id: 'meta/llama-3.3-70b-instruct:tdx', name: 'Llama 3.3 70B Instruct' }],
    apiKeys: [{ id: 'key-1', name: 'agents-prod', prefix: 'sk-tee-v1-4f' }],
  },
  GenerationLog: {
    generations: {
      totalCount: 1,
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [
        {
          cursor: 'cursor-1',
          node: {
            id: 'gen-1',
            createdAt: '2026-08-31T11:42:07.000Z',
            modelId: 'meta/llama-3.3-70b-instruct:tdx',
            modelName: 'Llama 3.3 70B Instruct',
            apiKeyId: 'key-1',
            apiKeyName: 'agents-prod',
            promptTokens: 1234,
            completionTokens: 567,
            costMicros: '2100',
            latencyMs: 4200,
            timeToFirstTokenMs: 312,
            tokensPerSecond: 48.23,
            status: 'OK',
            errorCode: null,
          },
        },
      ],
    },
  },
};

test.describe('Activity', () => {
  test('re-queries and repaints the tiles when the range changes', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);
    await mockConsole(page, ACTIVITY);

    await page.goto('/activity');

    await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
    await expect(page.getByText('$1.23')).toBeVisible();
    await expect(page.getByText('842', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Past 7 days' }).click();

    await expect(page.getByText('$45.67')).toBeVisible();
    await expect(page.getByText('11K', { exact: true })).toBeVisible();
    await expect(page.getByText('$1.23')).toBeHidden();
  });

  test('breaks the last 30 days down by model', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);
    await mockConsole(page, ACTIVITY);

    await page.goto('/activity');

    await expect(page.getByRole('img', { name: 'Tokens by model over the last 30 days' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Llama 3.3 70B Instruct' })).toBeVisible();
  });

  test('has no serious axe violations with its charts on screen', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);
    await mockConsole(page, ACTIVITY);

    await page.goto('/activity');
    await expect(page.getByText('$1.23')).toBeVisible();

    expect(await seriousViolations(page)).toEqual([]);
  });
});

test.describe('Logs', () => {
  test('lists metered generations and says prompt content is never stored', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);
    await mockConsole(page, LOGS);

    await page.goto('/logs');

    await expect(page.getByRole('heading', { level: 1, name: 'Logs' })).toBeVisible();
    await expect(page.getByText(/Prompt content is never stored/)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Llama 3.3 70B Instruct' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'agents-prod' })).toBeVisible();
  });

  test('has no serious axe violations with its filter row and table on screen', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);
    await mockConsole(page, LOGS);

    await page.goto('/logs');
    await expect(page.getByRole('cell', { name: 'Llama 3.3 70B Instruct' })).toBeVisible();

    expect(await seriousViolations(page)).toEqual([]);
  });

  test('downloads the filtered log as CSV', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);
    await mockConsole(page, LOGS);

    // The export is a REST endpoint on router-api, not a GraphQL operation.
    let requestedUrl = '';
    await page.route('**/activity/generations.csv*', async (route) => {
      requestedUrl = route.request().url();
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="generations-ws.csv"',
        },
        body: 'id,createdAt,modelId\r\ngen-1,2026-08-31T11:42:07.000Z,meta/llama-3.3-70b-instruct:tdx\r\n',
      });
    });

    await page.goto('/logs');
    await expect(page.getByRole('cell', { name: 'Llama 3.3 70B Instruct' })).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Export CSV' }).click(),
    ]);

    expect(download.suggestedFilename()).toBe('generations-ws.csv');

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe('/activity/generations.csv');
    expect(url.searchParams.get('workspaceId')).toBe('00000000-0000-4000-8000-0000000000a1');
    // The default range is the last 24 hours, and it travels with the export.
    const hours =
      (Date.parse(url.searchParams.get('to') as string) - Date.parse(url.searchParams.get('from') as string)) /
      3_600_000;
    expect(Math.round(hours)).toBe(24);
  });
});
