import { expect, type Page, test } from '@playwright/test';
import {
  CONSOLE_OPERATIONS,
  MIXED_CATALOGUE_DATA,
  PUBLISHED_DIGEST_HEX,
  PUBLISHED_HOST,
  PUBLISHED_JWS,
  REFRESHED_JWS,
  ROTATING_HOST,
  UNPUBLISHED_HOST,
  UPSTREAM_HOST,
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

/**
 * External models on the Models page (SUP-227, ADR-008 §7).
 *
 * The component tests pin the branching; what a real browser adds here is the
 * thing the acceptance criterion is actually about — both vocabularies rendered
 * into the *same table*, each confined to its own cell. A regression that blended
 * them would still satisfy a per-component assertion.
 */
test.describe('Models, with an external endpoint', () => {
  const mixed = { ...CONSOLE_OPERATIONS, ModelCatalogue: MIXED_CATALOGUE_DATA };

  function externalRow(page: Page) {
    return page
      .getByRole('table', { name: 'Model catalogue' })
      .getByRole('row', { name: /Llama 3\.3 70B \(partner\)/ });
  }

  test('badges the external row and nothing else', async ({ page, baseURL }) => {
    await mockClipboard(page);
    await signIn(page, baseURL as string, mixed);
    await page.goto('/models');

    await expect(externalRow(page).getByText('External')).toBeVisible();
    // One badge in the whole table: the information is "this one is different",
    // which an absent badge on everything else is what makes legible.
    await expect(page.getByText('External', { exact: true })).toHaveCount(1);
  });

  test('renders both vocabularies in one table, neither borrowing the other’s words', async ({ page, baseURL }) => {
    await mockClipboard(page);
    await signIn(page, baseURL as string, mixed);
    await page.goto('/models');

    await expect(
      page.getByRole('button', { name: `Attestation of ${UPSTREAM_HOST}: Verified by this router` }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: `Evidence for ${PUBLISHED_HOST}: Published` })).toBeVisible();

    // The external row carries no publication word, and the own-endpoint rows
    // carry no verdict — the separation ADR-008 §1 makes a contract.
    const external = externalRow(page);
    for (const word of ['Published', 'Stale', 'Not published']) {
      await expect(external.getByText(word, { exact: true })).toHaveCount(0);
    }
    const ownRow = page
      .getByRole('table', { name: 'Model catalogue' })
      .getByRole('row', { name: /Llama 3\.3 70B Instruct/ });
    await expect(ownRow.getByText(/by this router/)).toHaveCount(0);
  });

  test('says whose verdict it is, and what a measurement does not pin', async ({ page, baseURL }) => {
    await mockClipboard(page);
    await signIn(page, baseURL as string, mixed);
    await page.goto('/models');

    await page.getByRole('button', { name: `Attestation of ${UPSTREAM_HOST}: Verified by this router` }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'This router verified this upstream' })).toBeVisible();
    await expect(dialog).toContainText('not by you');
    await expect(dialog).toContainText('admits a cloud');
  });

  test('declares no TEE label for another deployment’s hardware', async ({ page, baseURL }) => {
    await mockClipboard(page);
    await signIn(page, baseURL as string, mixed);
    await page.goto('/models');

    // The TEE filter narrows on an operator's declaration about *this*
    // deployment, so selecting one hides the external row rather than guessing.
    await page.getByRole('tab', { name: 'AMD SEV-SNP' }).click();
    await expect(page.getByText('Llama 3.3 70B (partner)')).toHaveCount(0);
  });
});
