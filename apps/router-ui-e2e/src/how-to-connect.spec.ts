import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { type GraphQLFixtures, mockClipboard, signIn } from './fixtures';
import { API_ORIGIN } from './origins';

/**
 * "How to connect" on the API Keys page — the former `/gatekeeper` screen,
 * folded in next to the keys it is about (SUP-255).
 *
 * What a real browser adds over the component tests: the redirect from the old
 * route, the tabs as the reader will click them, and axe over a page that now
 * carries a diagram, a numbered command block and five code tabs.
 */

const LIVE_KEY = {
  __typename: 'ApiKey',
  id: 'key-1',
  name: 'production-agent',
  prefix: 'sk-tee-v1-4f',
  modelScope: ['meta/llama-3.3-70b-instruct:tdx'],
  createdAt: '2026-08-01T00:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  spendLimitMicros: null,
  spentTotalMicros: '0',
  requestsPerMinute: null,
  tokensPerMinute: null,
};

const OPERATIONS: GraphQLFixtures = {
  ApiKeys: {
    apiKeys: [LIVE_KEY],
    models: [{ __typename: 'Model', id: 'meta/llama-3.3-70b-instruct:tdx', name: 'Llama 3.3 70B', available: true }],
  },
};

async function seriousViolations(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}

test.describe('How to connect', () => {
  test('is where the old Gatekeeper route lands', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, OPERATIONS);

    await page.goto('/gatekeeper');

    await expect(page).toHaveURL(/\/keys#how-to-connect$/);
    await expect(page.getByRole('heading', { name: 'How to connect' })).toBeVisible();
  });

  test('has no Gatekeeper entry in the sidebar, and the header button points here', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, OPERATIONS);
    await page.goto('/keys');

    const nav = page.getByRole('navigation', { name: 'Console' });
    await expect(nav.getByRole('link', { name: 'API Keys' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Gatekeeper' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Connect a client' })).toHaveAttribute('href', '/keys#how-to-connect');
  });

  test('explains the flow, then the pre-filled setup, then the client — with nothing to substitute', async ({
    page,
    baseURL,
  }) => {
    await signIn(page, baseURL as string, OPERATIONS);
    await page.goto('/keys');

    const card = page.locator('#how-to-connect');
    await expect(card.getByRole('heading', { name: /How the connection works/ })).toBeVisible();
    await expect(card.getByRole('figure')).toBeVisible();
    await expect(card.getByRole('heading', { name: /Install the gatekeeper/ })).toBeVisible();
    await expect(card.getByRole('heading', { name: /Point your client at it/ })).toBeVisible();
    // Each step's lead is one line; the rest is behind a labelled ⓘ (SUP-262).
    await expect(card.getByText(/Five commands, already carrying/)).toBeVisible();
    await expect(card.getByText(/there is no certificate to trust/)).toHaveCount(0);
    await card.getByRole('button', { name: 'About these commands' }).click();
    await expect(page.getByText(/there is no certificate to trust/)).toBeVisible();
    await page.keyboard.press('Escape');

    const commands = await card.getByTestId('gatekeeper-setup').locator('ol pre code').allTextContents();
    expect(commands).toHaveLength(5);
    expect(commands.some((command) => command.includes(`--upstream ${API_ORIGIN}`))).toBe(true);
    for (const command of commands) {
      expect(command).toMatch(/^[^<>]*$/);
    }
  });

  test('offers VS Code and OpenCode beside curl, Python and Node, and copies them', async ({ page, baseURL }) => {
    await mockClipboard(page);
    await signIn(page, baseURL as string, OPERATIONS);
    await page.goto('/keys');

    const card = page.locator('#how-to-connect');
    for (const label of ['curl', 'Python', 'Node', 'VS Code', 'OpenCode']) {
      await expect(card.getByRole('tab', { name: label })).toBeVisible();
    }

    await card.getByRole('tab', { name: 'VS Code' }).click();
    const vscode = card.getByTestId('wiring-snippet-vscode');
    await expect(vscode).toContainText('"vendor": "customendpoint"');
    await expect(vscode).toContainText('http://127.0.0.1:8787/v1/chat/completions');
    await expect(vscode).toContainText('meta/llama-3.3-70b-instruct:tdx');

    await card.getByRole('tab', { name: 'OpenCode' }).click();
    const opencode = card.getByTestId('wiring-snippet-opencode');
    await expect(opencode).toContainText('"npm": "@ai-sdk/openai-compatible"');
    await expect(opencode).toContainText('"baseURL": "http://127.0.0.1:8787/v1"');

    await expect(card.getByRole('link', { name: 'Details in the documentation' })).toHaveAttribute(
      'href',
      'https://docs.router.superprotocol.com/',
    );
  });

  test('has no serious axe violations', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, OPERATIONS);
    await page.goto('/keys');
    // Loaded, not loading: a disabled brand button in the header is what axe
    // would otherwise flag, and it is not this card's.
    await expect(page.getByRole('row', { name: /production-agent/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How to connect' })).toBeVisible();

    expect(await seriousViolations(page)).toEqual([]);
  });
});
