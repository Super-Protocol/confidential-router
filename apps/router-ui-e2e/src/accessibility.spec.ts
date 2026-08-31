import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { CONSOLE_OPERATIONS } from './evidence-fixtures';
import { mockGraphQL, signIn } from './fixtures';

/**
 * The acceptance criterion for this work is "Lighthouse a11y ≥ 90 on the shell".
 * Lighthouse's accessibility category *is* axe-core, run headless, with the
 * score derived from which rules pass. Asserting on the axe results directly
 * gives the same coverage plus the thing a score cannot: which rule failed, on
 * which element. A Lighthouse run is recorded in the PR for the number itself.
 *
 * `serious` and `critical` are the impacts Lighthouse weights heavily enough
 * that a single one drops the score below 90 on a page this size.
 */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

async function auditPage(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => node.target.join(' ')),
  }));
}

/** The sign-in screen renders from this, so an audit of it has to say what it is. */
async function signInOptions(
  page: import('@playwright/test').Page,
  offers: Partial<{ bootstrap: boolean; github: boolean; google: boolean; magicLink: boolean }>,
): Promise<void> {
  await mockGraphQL(page, {
    SignInOptions: {
      signInOptions: {
        __typename: 'SignInOptions',
        bootstrap: false,
        github: true,
        google: true,
        magicLink: false,
        ...offers,
      },
    },
  });
}

test.describe('accessibility', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`the console shell has no serious axe violations in ${theme} mode`, async ({ page, baseURL }) => {
      await signIn(page, baseURL as string, CONSOLE_OPERATIONS);
      await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);

      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

      const violations = await auditPage(page);
      expect(violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))).toEqual([]);
    });
  }

  test('the sign-in screen has no serious axe violations', async ({ page }) => {
    await signInOptions(page, { magicLink: true });

    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    const violations = await auditPage(page);
    expect(violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))).toEqual([]);
  });

  test('the bootstrap screen has no serious axe violations', async ({ page }) => {
    // The one screen a marketplace deployment shows before anything else exists.
    await signInOptions(page, { bootstrap: true });

    await page.goto('/login');
    await page.getByRole('button', { name: 'Have a bootstrap token?' }).click();
    await expect(page.getByLabel('Bootstrap token')).toBeVisible();

    const violations = await auditPage(page);
    expect(violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))).toEqual([]);
  });

  test('the component gallery has no serious axe violations', async ({ page }) => {
    await page.goto('/dev/components');
    await expect(page.getByRole('heading', { level: 1, name: 'Components' })).toBeVisible();

    const violations = await auditPage(page);
    expect(violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))).toEqual([]);
  });

  test('the mobile drawer is reachable and labelled at a phone width', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, CONSOLE_OPERATIONS);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto('/');
    await page.getByRole('button', { name: 'Open navigation' }).click();

    const drawer = page.getByRole('dialog', { name: 'Console navigation' });
    await expect(drawer.getByRole('navigation', { name: 'Console' })).toBeVisible();

    const violations = await auditPage(page);
    expect(violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))).toEqual([]);
  });
});
