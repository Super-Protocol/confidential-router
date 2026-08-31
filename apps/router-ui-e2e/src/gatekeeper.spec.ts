import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { type GraphQLFixtures, signIn } from './fixtures';

const RELEASE = {
  __typename: 'GatekeeperRelease',
  version: 'v0.4.1',
  notesUrl: 'https://github.com/Super-Protocol/confidential-router/releases/tag/v0.4.1',
  checksumsUrl: 'https://github.com/Super-Protocol/confidential-router/releases/download/v0.4.1/checksums.txt',
  publishedAt: '2026-08-20T10:00:00.000Z',
  fetchedAt: '2026-08-31T09:00:00.000Z',
  stale: false,
  downloads: [
    {
      __typename: 'GatekeeperDownload',
      os: 'LINUX',
      arch: 'AMD64',
      name: 'gatekeeper_0.4.1_linux_amd64.tar.gz',
      url: 'https://example.invalid/gatekeeper_0.4.1_linux_amd64.tar.gz',
      sizeBytes: 14800000,
    },
    {
      __typename: 'GatekeeperDownload',
      os: 'MACOS',
      arch: 'ARM64',
      name: 'gatekeeper_0.4.1_darwin_arm64.zip',
      url: 'https://example.invalid/gatekeeper_0.4.1_darwin_arm64.zip',
      sizeBytes: 13100000,
    },
  ],
};

const OPERATIONS: GraphQLFixtures = { GatekeeperRelease: { gatekeeperRelease: RELEASE } };

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

test.describe('Gatekeeper', () => {
  test('links the published release, its assets and its checksums', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, OPERATIONS);

    await page.goto('/gatekeeper');

    await expect(page.getByRole('heading', { level: 1, name: 'Gatekeeper' })).toBeVisible();
    await expect(page.getByText('v0.4.1')).toBeVisible();

    const linux = page.getByRole('row', { name: /gatekeeper_0\.4\.1_linux_amd64/ });
    await expect(linux.getByText('14.8 MB')).toBeVisible();
    await expect(linux.getByRole('link')).toHaveAttribute('href', RELEASE.downloads[0].url);

    await expect(page.getByRole('link', { name: /Checksums/ })).toHaveAttribute('href', RELEASE.checksumsUrl);
    await expect(page.getByRole('link', { name: /Release notes/ })).toHaveAttribute('href', RELEASE.notesUrl);
  });

  test('explains the flow, the checks and the four setup commands', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, OPERATIONS);

    await page.goto('/gatekeeper');

    await expect(page.getByText('Bind it to the connection')).toBeVisible();
    await expect(page.getByText('Fail closed')).toBeVisible();
    await expect(page.getByText('Fail open')).toBeVisible();
    await expect(page.getByText('gatekeeper init', { exact: true })).toBeVisible();
    await expect(page.getByText('gatekeeper endpoint add router --upstream https://<hostname>')).toBeVisible();
    await expect(page.getByText('gatekeeper endpoint trust add router <evidenceDigest>')).toBeVisible();
    await expect(page.getByText('gatekeeper run', { exact: true })).toBeVisible();
  });

  test('offers a checksum-verifying one-liner for each platform', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, OPERATIONS);

    await page.goto('/gatekeeper');

    // The URL is `releases/latest/download/...`: the installer that ships with
    // the release, not a script from a branch.
    await expect(
      page.getByText(
        'curl -fsSL https://github.com/Super-Protocol/confidential-router/releases/latest/download/install.sh | sh',
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        'irm https://github.com/Super-Protocol/confidential-router/releases/latest/download/install.ps1 | iex',
      ),
    ).toBeVisible();
    await expect(page.getByText(/verifies it against the release checksums/)).toBeVisible();
  });

  test('keeps the setup usable when no build has been published', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, { GatekeeperRelease: { gatekeeperRelease: null } });

    await page.goto('/gatekeeper');

    await expect(page.getByText('No published build yet')).toBeVisible();
    await expect(page.getByText('gatekeeper init', { exact: true })).toBeVisible();
  });

  test('has no serious axe violations', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, OPERATIONS);

    await page.goto('/gatekeeper');
    await expect(page.getByRole('heading', { level: 1, name: 'Gatekeeper' })).toBeVisible();

    expect(await seriousViolations(page)).toEqual([]);
  });
});
