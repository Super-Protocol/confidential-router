import { expect, type Page, test } from '@playwright/test';
import {
  CONSOLE_OPERATIONS,
  PUBLISHED_DIGEST_HEX,
  PUBLISHED_HOST,
  PUBLISHED_JWS,
  REFRESHED_JWS,
  ROTATING_HOST,
  UNPUBLISHED_HOST,
} from './evidence-fixtures';
import { mockClipboard, signIn } from './fixtures';

/**
 * Copying is one of the two actions the evidence modal exists for, so the suite
 * reads the clipboard back rather than trusting the button's own confirmation.
 * The console's origin is a named http one and therefore not a secure context,
 * so the clipboard is a stand-in rather than the browser's — `mockClipboard`
 * explains the trade.
 */
async function enterConsole(page: Page, baseURL: string, path: string): Promise<void> {
  await mockClipboard(page);
  await signIn(page, baseURL, CONSOLE_OPERATIONS);
  await page.goto(path);
}

function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe('Overview', () => {
  test('shows the week’s usage and the endpoints behind it', async ({ page, baseURL }) => {
    await enterConsole(page, baseURL as string, '/');

    await expect(page.getByRole('group', { name: 'Spend' })).toContainText('$149.34');
    await expect(page.getByRole('group', { name: 'Requests' })).toContainText('10.9K');
    await expect(page.getByRole('group', { name: 'Tokens' })).toContainText('780.3M');
    await expect(page.getByRole('group', { name: 'Evidence coverage' })).toContainText('100%');

    const table = page.getByRole('table', { name: 'Confidential endpoints' });
    await expect(table.getByRole('row', { name: new RegExp(PUBLISHED_HOST) })).toContainText('598M');
    await expect(page.getByRole('button', { name: `Evidence for ${ROTATING_HOST}: Stale` })).toBeVisible();
  });

  test('copies the digest a gatekeeper pins', async ({ page, baseURL }) => {
    await enterConsole(page, baseURL as string, '/');

    await page.getByRole('button', { name: `Copy evidence digest for ${PUBLISHED_HOST}` }).click();

    expect(await clipboardText(page)).toBe(PUBLISHED_DIGEST_HEX);
  });

  test('opens the evidence modal from a row and copies the JWS', async ({ page, baseURL }) => {
    await enterConsole(page, baseURL as string, '/');

    await page.getByRole('button', { name: `Evidence for ${PUBLISHED_HOST}: Published` }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Evidence published' })).toBeVisible();
    await expect(dialog).toContainText('intel-tdx-quote-v5');
    await expect(dialog).toContainText('MRTD');
    await expect(dialog).toContainText('The published chain terminates at CN=swarm-cloud-prod');

    await dialog.getByRole('button', { name: 'Copy evidence JWS' }).click();

    expect(await clipboardText(page)).toBe(PUBLISHED_JWS);
  });

  test('shows the rotating state and fetches a fresh quote', async ({ page, baseURL }) => {
    await enterConsole(page, baseURL as string, '/');

    await page.getByRole('button', { name: `Evidence for ${ROTATING_HOST}: Stale` }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Signing key rotating' })).toBeVisible();
    await expect(dialog).toContainText('Verify again shortly');
    await expect(dialog).toContainText('12 min ago');

    await dialog.getByRole('button', { name: 'Fetch fresh quote' }).click();

    await expect(dialog).toContainText('3s ago');
    await dialog.getByRole('button', { name: 'Copy evidence JWS' }).click();
    expect(await clipboardText(page)).toBe(REFRESHED_JWS);
  });
});

test.describe('Models', () => {
  test('prices the catalogue per 1M tokens and names the endpoint serving each model', async ({ page, baseURL }) => {
    await enterConsole(page, baseURL as string, '/models');

    const row = page
      .getByRole('table', { name: 'Model catalogue' })
      .getByRole('row', { name: /Llama 3\.3 70B Instruct/ });
    await expect(row).toContainText('meta/llama-3.3-70b-instruct:tdx');
    await expect(row).toContainText(PUBLISHED_HOST);
    await expect(row).toContainText('$0.28');
    await expect(row).toContainText('$0.42');
  });

  test('narrows the catalogue to one TEE', async ({ page, baseURL }) => {
    await enterConsole(page, baseURL as string, '/models');

    await page.getByRole('tab', { name: 'AMD SEV-SNP' }).click();

    await expect(page.getByText('Qwen2.5 72B Instruct')).toBeVisible();
    await expect(page.getByText('Llama 3.3 70B Instruct')).toHaveCount(0);
  });

  test('opens the same evidence modal and copies the JWS', async ({ page, baseURL }) => {
    await enterConsole(page, baseURL as string, '/models');

    await page.getByRole('button', { name: `Evidence for ${PUBLISHED_HOST}: Published` }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Evidence published' })).toBeVisible();
    await expect(dialog).toContainText(PUBLISHED_HOST);

    await dialog.getByRole('button', { name: 'Copy evidence JWS' }).click();

    expect(await clipboardText(page)).toBe(PUBLISHED_JWS);
  });

  test('offers nothing to copy for an endpoint with no published bundle', async ({ page, baseURL }) => {
    await enterConsole(page, baseURL as string, '/models');

    await page.getByRole('button', { name: `Evidence for ${UNPUBLISHED_HOST}: Not published` }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Nothing published' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy evidence JWS' })).toBeDisabled();
  });
});
