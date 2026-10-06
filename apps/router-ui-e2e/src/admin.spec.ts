import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { ADMIN_OPERATIONS, TRUSTED_MEASUREMENT } from './admin-fixtures';
import { signIn, viewerIsAdmin } from './fixtures';

/**
 * The admin section in a browser: the gating, the two screens, and an axe audit
 * of each in both themes — the same bar `accessibility.spec.ts` holds the shell
 * and the attestation inspector to.
 */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

async function auditPage(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

  return results.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    }));
}

async function signInAsAdmin(page: Page, baseURL: string) {
  await signIn(page, baseURL, { ViewerIsAdmin: viewerIsAdmin(true), ...ADMIN_OPERATIONS });
}

test.describe('the admin section', () => {
  test('is reachable from the sidebar for an administrator', async ({ page, baseURL }) => {
    await signInAsAdmin(page, baseURL as string);

    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Console' });
    await nav.getByRole('link', { name: 'External endpoints' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'External endpoints' })).toBeVisible();
    await expect(page.getByText('Verified by this router')).toBeVisible();
  });

  /**
   * Ruling 3: a member reads the section and changes nothing. The entry is out
   * of their sidebar, and the screen itself still answers — typing the URL is
   * not an escalation here, it is the transparency ADR-008 §7 asks for.
   */
  test('is out of a member’s sidebar, and still readable if they go there', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, ADMIN_OPERATIONS);

    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Console' });
    await expect(nav.getByRole('link', { name: 'External endpoints' })).toHaveCount(0);
    await expect(nav.getByRole('heading', { name: 'Administration' })).toHaveCount(0);

    await page.goto('/admin/endpoints');
    await expect(page.getByRole('heading', { level: 1, name: 'External endpoints' })).toBeVisible();
    await expect(page.getByTestId('admin-read-only-notice')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add external endpoint' })).toHaveCount(0);
  });

  test('shows the evidence summary and the verdict timeline in the drawer', async ({ page, baseURL }) => {
    await signInAsAdmin(page, baseURL as string);

    await page.goto('/admin/endpoints');
    await page.getByRole('button', { name: /^Open qwen3-coder:/ }).click();

    const drawer = page.getByRole('dialog');
    // Scoped to the standing summary: the timeline's own entries each carry one
    // too, which is exactly what ruling 1 asks for and what makes a bare
    // `getByText` ambiguous here.
    const current = drawer.getByRole('region', { name: 'Evidence summary (current)' });
    await expect(current).toBeVisible();
    await expect(current.getByText('Deployment/vllm')).toBeVisible();
    await expect(current.getByText(/ghcr.io\/example\/vllm@sha256:1111/)).toBeVisible();
    await expect(drawer.getByTestId('endpoint-timeline').getByText('Image digest changed')).toBeVisible();
    // The registration and the digest change each render their own.
    await expect(drawer.getByTestId('evidence-summary')).toHaveCount(3);
  });

  test('fills the register dialog from a pasted connection link', async ({ page, baseURL }) => {
    await signInAsAdmin(page, baseURL as string);

    await page.goto('/admin/endpoints');
    await page.getByRole('button', { name: 'Add external endpoint' }).click();

    await page
      .getByLabel('Paste a connection link')
      .fill('https://pasted.swarm.example/v1#key=sk-up-pasted&model=qwen3-coder-30b');
    await page.getByRole('button', { name: 'Fill in' }).click();

    // `exact`, or "Display name" in the model row matches too.
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('pasted-swarm-example');
    await expect(page.getByLabel('Base URL')).toHaveValue('https://pasted.swarm.example');
    await expect(page.getByLabel('Model id on this router')).toHaveValue('qwen3-coder-30b');
    // Decision 4: the price is never in the link.
    await expect(page.getByLabel('Prompt, USD / 1M')).toHaveValue('');
    // And the pasted credential does not stay in the form.
    await expect(page.getByLabel('Paste a connection link')).toHaveValue('');
  });

  test('spells the cloud-granularity warning out on the trust list', async ({ page, baseURL }) => {
    await signInAsAdmin(page, baseURL as string);

    await page.goto('/admin/trust');
    const note = page.getByRole('note', { name: 'How measurement trust works' });
    await expect(note).toContainText('A measurement admits a cloud, never a deployment.');
    await expect(note).toContainText('takes effect on the next check');

    await page.getByRole('button', { name: `Remove measurement ${TRUSTED_MEASUREMENT.slice(0, 6)}…` }).click();
    await expect(page.getByRole('dialog')).toContainText('2 registered endpoints were admitted');
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`the external endpoints screen has no serious axe violations in ${theme} mode`, async ({ page, baseURL }) => {
      await signInAsAdmin(page, baseURL as string);
      await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);

      await page.goto('/admin/endpoints');
      await expect(page.getByRole('heading', { level: 1, name: 'External endpoints' })).toBeVisible();

      expect(await auditPage(page)).toEqual([]);
    });

    test(`the endpoint drawer has no serious axe violations in ${theme} mode`, async ({ page, baseURL }) => {
      await signInAsAdmin(page, baseURL as string);
      await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);

      await page.goto('/admin/endpoints');
      await page.getByRole('button', { name: /^Open qwen3-coder:/ }).click();
      await expect(page.getByRole('dialog').getByRole('region', { name: 'Evidence summary (current)' })).toBeVisible();

      expect(await auditPage(page)).toEqual([]);
    });

    test(`the trust list has no serious axe violations in ${theme} mode`, async ({ page, baseURL }) => {
      await signInAsAdmin(page, baseURL as string);
      await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);

      await page.goto('/admin/trust');
      await expect(page.getByRole('heading', { level: 1, name: 'Trust list' })).toBeVisible();

      expect(await auditPage(page)).toEqual([]);
    });
  }

  test('the register dialog has no serious axe violations', async ({ page, baseURL }) => {
    // The densest form in the console: ten labelled fields, one of them a
    // secret, plus a repeatable fieldset.
    await signInAsAdmin(page, baseURL as string);

    await page.goto('/admin/endpoints');
    await page.getByRole('button', { name: 'Add external endpoint' }).click();
    await expect(page.getByLabel('Upstream API key')).toBeVisible();

    expect(await auditPage(page)).toEqual([]);
  });

  test('the add-measurement dialog has no serious axe violations', async ({ page, baseURL }) => {
    await signInAsAdmin(page, baseURL as string);

    await page.goto('/admin/trust');
    await page.getByRole('button', { name: 'Trust a measurement' }).click();
    await expect(page.getByLabel('Launch measurement')).toBeVisible();

    expect(await auditPage(page)).toEqual([]);
  });
});
