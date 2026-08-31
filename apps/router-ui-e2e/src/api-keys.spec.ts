import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { type GraphQLFixtures, signIn } from './fixtures';

const CREATED_SECRET = 'sk-tee-v1-aabbccddeeff00112233445566778899aabbccdd';

const LIVE_KEY = {
  __typename: 'ApiKey',
  id: 'key-1',
  name: 'production-agent',
  prefix: 'sk-tee-v1-4f',
  modelScope: ['meta/llama-3.3-70b-instruct:tdx'],
  createdAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-12-31T23:59:59.999Z',
  lastUsedAt: '2026-08-30T12:00:00.000Z',
  revokedAt: null,
  spendLimitMicros: '50000000',
  spentTotalMicros: '12500000',
  requestsPerMinute: 60,
  tokensPerMinute: null,
};

const MODELS = [
  { __typename: 'Model', id: 'meta/llama-3.3-70b-instruct:tdx', name: 'Llama 3.3 70B Instruct' },
  { __typename: 'Model', id: 'gpt-oss-120b:tdx', name: 'GPT-OSS 120B' },
];

/** The API is answered from fixtures; `createApiKey` echoes back the name it was given. */
const OPERATIONS: GraphQLFixtures = {
  ApiKeys: { apiKeys: [LIVE_KEY], models: MODELS },
  CreateApiKey: (variables) => {
    const input = variables.input as { name: string };
    return {
      createApiKey: {
        __typename: 'ApiKeyCreated',
        secret: CREATED_SECRET,
        key: { ...LIVE_KEY, id: 'key-2', name: input.name, prefix: CREATED_SECRET.slice(0, 12) },
      },
    };
  },
};

/**
 * The shell is audited in `accessibility.spec.ts`; these two screens add a
 * table, a multi-step form and a dialog, which is where contrast and labelling
 * regressions actually appear.
 */
async function seriousViolations(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}

test.describe('API keys', () => {
  test('lists the workspace keys with their scope, usage and limit', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, OPERATIONS);

    await page.goto('/keys');

    const row = page.getByRole('row', { name: /production-agent/ });
    await expect(row).toBeVisible();
    await expect(row.getByText('sk-tee-v1-4f…')).toBeVisible();
    await expect(row.getByText('Llama 3.3 70B Instruct')).toBeVisible();
    await expect(row.getByText('$12.50')).toBeVisible();
  });

  test('creates a key and shows it once, wired into the drop-in snippet', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, OPERATIONS);

    await page.goto('/keys');
    await page.getByRole('button', { name: 'New key' }).click();
    await page.getByLabel('Name').fill('ci-agent');
    await page.getByRole('button', { name: 'Create key' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Copy your key now')).toBeVisible();
    await expect(dialog.getByTestId('created-key-secret')).toContainText(CREATED_SECRET);

    // The acceptance criterion: the snippet carries the key the user just made.
    const snippet = dialog.getByTestId('wiring-snippet-curl');
    await expect(snippet).toContainText(CREATED_SECRET.slice(0, 12));
    await expect(snippet).toContainText('http://127.0.0.1:8787/v1');

    await dialog.getByRole('tab', { name: 'Python' }).click();
    await expect(dialog.getByTestId('wiring-snippet-python')).toContainText(`api_key="${CREATED_SECRET}"`);
  });

  test('offers the drop-in snippet on the screen itself, with only the key prefix', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, OPERATIONS);

    await page.goto('/keys');

    const snippet = page.getByTestId('wiring-snippet-curl');
    await expect(snippet).toContainText('sk-tee-v1-4f…');
    await expect(snippet).not.toContainText(CREATED_SECRET);
  });

  test('invites a first key when the workspace has none', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, { ...OPERATIONS, ApiKeys: { apiKeys: [], models: MODELS } });

    await page.goto('/keys');

    await expect(page.getByText('No keys yet')).toBeVisible();
  });

  test('has no serious axe violations, table and create dialog included', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, OPERATIONS);

    await page.goto('/keys');
    await expect(page.getByRole('row', { name: /production-agent/ })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByRole('button', { name: 'New key' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
});
