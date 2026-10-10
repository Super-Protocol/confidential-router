import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signIn, viewerIsAdmin } from './fixtures';

/**
 * The admin Export & import section in a browser (SUP-271): the gate, the
 * download, the check-then-import sequence and its refusal, and an axe audit in
 * both themes. The live round trip against a real router-api is
 * `cross-app.spec.ts`; this one is the screen against fixtures.
 *
 * `CR_E2E_SCREENSHOT_DIR` saves a full-page image of each state the PR shows.
 */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);
const SCREENSHOT_DIR = process.env.CR_E2E_SCREENSHOT_DIR;
const SHA = '8135904c9572ff34b97a3fe397ed7957054940afa6c6cb12cdea3e3e6c590659';
const FILE_NAME = 'router-export-20261010-1200-api.router.example.json.gz';

async function blockingViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => ({
      id: violation.id,
      help: violation.help,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    }));
}

async function capture(page: Page, name: string): Promise<void> {
  if (SCREENSHOT_DIR) {
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
  }
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    applied: false,
    ok: true,
    schemaVersion: 1,
    exportedAt: '2026-10-10T12:00:00.000Z',
    source: {
      publicBaseUrl: 'https://api.router.example',
      routerVersion: '0.17.1',
      evidenceDigest: 'sha256/6b1f9c04a7e2d95c3f8b0a1d4e7f2c5b8a9d0e3f6c1b4a7d',
    },
    contentSha256: SHA,
    counts: { users: 42, inviteCodes: 50, inviteCodesUnredeemed: 31 },
    totalBalanceMicros: '3187250000',
    refusals: [],
    sections: [
      { section: 'users', inBundle: 42, toCreate: 41, alreadyPresent: 1, conflicts: [] },
      { section: 'workspaces', inBundle: 42, toCreate: 41, alreadyPresent: 1, conflicts: [] },
      { section: 'workspaceMembers', inBundle: 42, toCreate: 41, alreadyPresent: 1, conflicts: [] },
      { section: 'creditLedger', inBundle: 118, toCreate: 118, alreadyPresent: 0, conflicts: [] },
      { section: 'inviteCodes', inBundle: 50, toCreate: 50, alreadyPresent: 0, conflicts: [] },
      { section: 'inviteRedemptions', inBundle: 19, toCreate: 19, alreadyPresent: 0, conflicts: [] },
      { section: 'externalEndpoints', inBundle: 2, toCreate: 2, alreadyPresent: 0, conflicts: [] },
      { section: 'externalModels', inBundle: 5, toCreate: 5, alreadyPresent: 0, conflicts: [] },
      { section: 'trustedMeasurements', inBundle: 3, toCreate: 3, alreadyPresent: 0, conflicts: [] },
    ],
    notes: [
      '1 operator account(s) already exist here under a new id; the exported account of the same address is merged into each, with its workspace, balance and attribution.',
      '2 external endpoint(s) are imported switched off and without an upstream API key — the export carries no secrets. Enter each key again under Administration → External endpoints, then enable it.',
    ],
    ...overrides,
  };
}

/** Answers the two REST endpoints; `imports` are the reports to give, in order. */
async function mockDataApi(page: Page, imports: Record<string, unknown>[]): Promise<{ urls: string[] }> {
  const urls: string[] = [];
  await page.route('**/admin/data/export', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/gzip',
      headers: {
        'Content-Disposition': `attachment; filename="${FILE_NAME}"`,
        'X-Export-Sha256': SHA,
        'Access-Control-Expose-Headers': 'Content-Disposition, X-Export-Sha256',
      },
      body: Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
    }),
  );
  await page.route('**/admin/data/import**', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204 });
      return;
    }
    urls.push(route.request().url());
    expect(route.request().headers()['content-type']).toBe('application/gzip');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(imports[Math.min(urls.length, imports.length) - 1]),
    });
  });
  return { urls };
}

async function openAsAdmin(page: Page, baseURL: string, theme: 'light' | 'dark' = 'dark'): Promise<void> {
  await signIn(page, baseURL, { ViewerIsAdmin: viewerIsAdmin(true) });
  await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
  await page.goto('/admin/migration');
  await expect(page.getByRole('heading', { level: 1, name: 'Export & import' })).toBeVisible();
}

async function chooseFile(page: Page): Promise<void> {
  await page.getByTestId('import-file').setInputFiles({
    name: FILE_NAME,
    mimeType: 'application/gzip',
    buffer: Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
  });
}

test.describe('the Export & import section', () => {
  test('is neither in the sidebar nor on the page for a member', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);
    await page.goto('/admin/migration');

    await expect(page.getByTestId('data-migration-restricted')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Export & import' })).toHaveCount(0);
    await expect(page.getByTestId('export-button')).toHaveCount(0);
    await expect(page.getByTestId('import-file')).toHaveCount(0);
  });

  test('downloads the export and shows the hash to compare on the other side', async ({ page, baseURL }) => {
    await mockDataApi(page, []);
    await openAsAdmin(page, baseURL as string);
    await expect(page.getByRole('link', { name: 'Export & import' })).toBeVisible();
    await expect(page.getByTestId('export-card')).toContainText('everyone issues new keys after a migration');

    const download = page.waitForEvent('download');
    await page.getByTestId('export-button').click();

    expect((await download).suggestedFilename()).toBe(FILE_NAME);
    await expect(page.getByTestId('export-done')).toContainText(FILE_NAME);
    await expect(page.getByTestId('export-sha')).toHaveText(SHA);
  });

  test('checks a file, shows what would be created, and imports only that file', async ({ page, baseURL }) => {
    const api = await mockDataApi(page, [report(), report({ applied: true })]);
    await openAsAdmin(page, baseURL as string);

    await expect(page.getByTestId('import-apply')).toBeDisabled();
    await chooseFile(page);
    await expect(page.getByTestId('import-apply')).toBeDisabled();
    await page.getByTestId('import-check').click();

    await expect(page.getByTestId('import-verdict')).toHaveText('Ready to import — nothing written yet');
    await expect(page.getByTestId('import-sha')).toHaveText(SHA);
    await expect(page.getByTestId('import-total-balance')).toHaveText('$3,187.25');
    const accounts = page.getByTestId('import-section-users').getByRole('cell');
    await expect(accounts).toHaveText(['Accounts', '42', '41', '1', '0']);
    await expect(page.getByTestId('import-notes')).toContainText('without an upstream API key');
    expect(api.urls).toHaveLength(1);
    expect(new URL(api.urls[0] as string).search).toBe('');

    await page.getByTestId('import-apply').click();

    await expect(page.getByTestId('import-verdict')).toContainText('Imported');
    await expect(page.getByTestId('import-next-steps')).toContainText('each person issues new ones under API Keys');
    expect(new URL(api.urls[1] as string).searchParams.get('apply')).toBe('true');
    expect(new URL(api.urls[1] as string).searchParams.get('expect')).toBe(SHA);
    await expect(page.getByTestId('import-apply')).toBeDisabled();
  });

  test('will not import into a deployment that is not fresh', async ({ page, baseURL }) => {
    await mockDataApi(page, [
      report({
        ok: false,
        refusals: [
          'This deployment is not fresh: 7 account(s) exist here that are neither in the export nor an operator’s own. An export is only imported into a deployment nobody has signed up to yet.',
        ],
      }),
    ]);
    await openAsAdmin(page, baseURL as string);
    await chooseFile(page);
    await page.getByTestId('import-check').click();

    await expect(page.getByTestId('import-verdict')).toHaveText('Cannot be imported — nothing written');
    await expect(page.getByTestId('import-refusals')).toContainText('This deployment is not fresh: 7 account(s)');
    await expect(page.getByTestId('import-apply')).toBeDisabled();
    await capture(page, 'import-refused-dark');
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`has no serious axe violations before, during or after an import, in ${theme} mode`, async ({
      page,
      baseURL,
    }) => {
      await mockDataApi(page, [report(), report({ applied: true })]);
      await openAsAdmin(page, baseURL as string, theme);

      await page.getByTestId('export-button').click();
      await expect(page.getByTestId('export-done')).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);
      await capture(page, `export-${theme}`);

      await chooseFile(page);
      await page.getByTestId('import-check').click();
      await expect(page.getByTestId('import-report')).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);
      await capture(page, `import-dry-run-${theme}`);

      await page.getByTestId('import-apply').click();
      await expect(page.getByTestId('import-next-steps')).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);
      await capture(page, `import-applied-${theme}`);
    });
  }
});
