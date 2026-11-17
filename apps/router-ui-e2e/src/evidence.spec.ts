import { expect, type Page, test } from '@playwright/test';
import {
  CONSOLE_OPERATIONS,
  EXTERNAL_ONLY_CONSOLE_OPERATIONS,
  MIXED_CATALOGUE_DATA,
  PUBLISHED_DIGEST_HEX,
  PUBLISHED_HOST,
  PUBLISHED_JWS,
  REFRESHED_JWS,
  ROTATING_HOST,
  UNPUBLISHED_HOST,
  UPSTREAM_DIGEST_HEX,
  UPSTREAM_HOST,
} from './evidence-fixtures';
import { DEPLOYMENT_DIGEST_HEX, mockClipboard, signIn } from './fixtures';

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

  test('does not report 0% coverage for a week served entirely by external endpoints', async ({ page, baseURL }) => {
    // SUP-421: coverage is about bundles *this* platform published, and an
    // external endpoint has none — the router verified it instead. With no
    // coverable request in the week there is no ratio, and "0%" on this tile
    // reads as the product's own promise never once kept.
    await mockClipboard(page);
    await signIn(page, baseURL as string, EXTERNAL_ONLY_CONSOLE_OPERATIONS);
    await page.goto('/');

    const tile = page.getByRole('group', { name: 'Evidence coverage' });

    await expect(tile).toContainText('coverage does not apply here');
    await expect(tile).toContainText('all 34 generations were served by external endpoints');
    await expect(tile).toContainText('verified by this router');
    await expect(tile).not.toContainText('0%');
  });

  /**
   * The pin decision a reader is sent here to make (SUP-541).
   *
   * `gatekeeper endpoint trust add --from-upstream` prints all 64 hex
   * characters and asks y/n, and the published docs tell the reader to compare
   * it with what Overview shows. Overview showed `sha256:3509d9…100f16` — a
   * twelve-character comparison, with the rest of the value reachable only
   * through a tooltip and the clipboard. This asserts the whole string is on
   * the page, because an elision of it is not the comparison the docs ask for.
   */
  test('prints this deployment’s evidence digest in full, as the gatekeeper prints it', async ({ page, baseURL }) => {
    await enterConsole(page, baseURL as string, '/');

    const block = page.getByTestId('deployment-digest');
    await expect(block).toContainText('api.router.superprotocol.com');
    await expect(page.getByTestId('deployment-digest-value')).toHaveText(`sha256:${DEPLOYMENT_DIGEST_HEX}`);
    await expect(block).toContainText('character for character');
  });

  test('copies that digest whole, so it can be diffed rather than read', async ({ page, baseURL }) => {
    await enterConsole(page, baseURL as string, '/');

    await page.getByRole('button', { name: 'Copy the evidence digest of api.router.superprotocol.com' }).click();

    expect(await clipboardText(page)).toBe(`sha256:${DEPLOYMENT_DIGEST_HEX}`);
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

    // The chips are the TEEs the deployment's own endpoints publish evidence
    // from (SUP-260), so this narrows on a label read off a root certificate.
    await page.getByRole('tab', { name: 'AMD SEV-SNP (Azure)' }).click();

    /*
     * Rows rather than bare text: a model's name is a substring of its own slug
     * and of its endpoint's hostname — "DeepSeek-V3" is in
     * `deepseek/deepseek-v3:tdx` and in `deepseek-v3.tee.swarm.cloud` — so
     * `getByText` matches three nodes and trips strict mode. The row's
     * accessible name covers every cell, which is what the test means anyway.
     */
    const table = page.getByRole('table', { name: 'Model catalogue' });
    await expect(table.getByRole('row', { name: /DeepSeek-V3/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /Llama 3\.3 70B Instruct/ })).toHaveCount(0);
    // Its endpoint publishes nothing, so it is under no TEE chip at all.
    await expect(table.getByRole('row', { name: /Qwen2\.5 72B Instruct/ })).toHaveCount(0);
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

  test('tags no row as external — the serving topology is not shown to a user', async ({ page, baseURL }) => {
    await mockClipboard(page);
    await signIn(page, baseURL as string, mixed);
    await page.goto('/models');

    await expect(externalRow(page)).toBeVisible();
    await expect(page.getByText('External', { exact: true })).toHaveCount(0);
  });

  test('spells the upstream’s evidence digest in hex, never in the base64 wire form', async ({ page, baseURL }) => {
    await mockClipboard(page);
    await signIn(page, baseURL as string, mixed);
    await page.goto('/models');

    await page.getByRole('button', { name: `Attestation of ${UPSTREAM_HOST}: Verified by this router` }).click();
    const dialog = page.getByRole('dialog');
    // Two renderings of one value: the elision a cell has room for, and the
    // whole string for assistive technology — which used to exist only in a
    // tooltip and on the clipboard, neither of which a screen reader reaches
    // (SUP-541).
    await expect(dialog.getByText(/^sha256:41de2c07…/)).toBeVisible();
    await expect(dialog.getByText(`sha256:${UPSTREAM_DIGEST_HEX}`, { exact: true })).toHaveCount(1);
    // The canonical `sha256/<base64url>` form is the wire format and stays
    // there (SUP-115); this dialog is where it leaked in 0.15.0 (SUP-255).
    await expect(dialog).not.toContainText(/sha256\//);
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

  test('says whose verdict it is, and that it covers the approved deployment', async ({ page, baseURL }) => {
    await mockClipboard(page);
    await signIn(page, baseURL as string, mixed);
    await page.goto('/models');

    await page.getByRole('button', { name: `Attestation of ${UPSTREAM_HOST}: Verified by this router` }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'This router verified this upstream' })).toBeVisible();
    await expect(dialog).toContainText('not by you');
    // Two-factor trust (SUP-252): the cloud by measurement and the deployment by
    // the digest its operator approved — not the cloud alone.
    await expect(dialog).toContainText('the one its operator approved');
  });

  test('names no TEE for another deployment’s hardware', async ({ page, baseURL }) => {
    await mockClipboard(page);
    await signIn(page, baseURL as string, mixed);
    await page.goto('/models');

    // The TEE filter narrows on what *this* deployment's endpoints publish, so
    // selecting one hides the external row rather than guessing at its silicon.
    await page.getByRole('tab', { name: 'AMD SEV-SNP (Azure)' }).click();
    await expect(page.getByText('Llama 3.3 70B (partner)')).toHaveCount(0);
  });
});
