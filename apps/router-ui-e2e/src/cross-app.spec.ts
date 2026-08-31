/**
 * The console against the real router-api.
 *
 * These are the flows that cross an app boundary, so they are the ones no
 * amount of GraphQL mocking can keep honest: the screens here read whatever the
 * running API answers, and the last test takes a key minted in the browser and
 * spends it against `/v1`.
 *
 * Run by the `cross-app` Playwright project only — see `playwright.config.ts`.
 */
import { expect, test } from '@playwright/test';
import { readHandoff, type StackHandoff, useSession } from './stack';

let handoff: StackHandoff;

test.beforeAll(() => {
  handoff = readHandoff();
});

test.beforeEach(async ({ page, baseURL }) => {
  await useSession(page, baseURL as string, handoff);
});

test.describe('the console, against a live router-api', () => {
  test('renders the signed-in shell with the workspace the API provisioned', async ({ page }) => {
    await page.goto('/');

    // Not redirected to the login screen: the session cookie travelled and the
    // API answered the session query.
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: `Account: ${handoff.email}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Workspace: ${handoff.email}` })).toBeVisible();
  });

  test('lists the catalogue the router is configured with', async ({ page }) => {
    await page.goto('/models');

    await expect(page.getByRole('table', { name: 'Model catalogue' })).toBeVisible();
    await expect(page.getByText('Llama 3.3 70B Instruct').first()).toBeVisible();
  });

  test('shows the evidence the endpoint actually published', async ({ page }) => {
    await page.goto('/');

    const endpoints = page.getByRole('table', { name: 'Confidential endpoints' });
    await expect(endpoints.getByRole('row', { name: new RegExp(handoff.endpointHostname) })).toBeVisible();
  });

  test('shows the credits the checkout actually recorded', async ({ page }) => {
    await page.goto('/credits');

    const dollars = `$${(handoff.balanceMicros / 1_000_000).toFixed(2)}`;
    await expect(page.getByText(dollars, { exact: false }).first()).toBeVisible();
  });

  test('lists the key the stack minted through the same API', async ({ page }) => {
    await page.goto('/keys');

    await expect(page.getByRole('row', { name: /Demo key/ })).toBeVisible();
  });

  test('mints a key in the browser that the gateway then accepts', async ({ page, request }) => {
    await page.goto('/keys');
    await page.getByRole('button', { name: 'New key' }).click();
    await page.getByLabel('Name').fill('minted-in-the-browser');
    await page.getByRole('button', { name: 'Create key' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Copy your key now')).toBeVisible();
    // The block carries its own copy button, so its text is the key plus a
    // label; the key is what matches the minting format.
    const shown = await dialog.getByTestId('created-key-secret').innerText();
    const secret = /sk-tee-v1-[A-Za-z0-9_-]{43}/.exec(shown)?.[0];
    expect(secret, `no key in the dialog text: ${shown}`).toBeDefined();

    // The whole point of the flow: a credential the console just showed is one
    // the gateway will honour.
    const completion = await request.post(`${handoff.apiBaseUrl}/v1/chat/completions`, {
      headers: { authorization: `Bearer ${secret as string}`, 'content-type': 'application/json' },
      data: {
        model: 'meta/llama-3.3-70b-instruct:tdx',
        messages: [{ role: 'user', content: 'Minted in the browser' }],
      },
    });

    expect(completion.status()).toBe(200);
    const body = (await completion.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toContain('Minted in the browser');
  });

  test('shows the generations those keys produced, under Activity and Logs', async ({ page }) => {
    await page.goto('/activity');
    await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();

    // Activity aggregates; the per-generation rows are on Logs, which is where
    // a call made a moment ago has to show up by name.
    await page.goto('/logs');
    await expect(page.getByRole('heading', { level: 1, name: 'Logs' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Llama 3.3 70B Instruct' }).first()).toBeVisible();
  });
});
