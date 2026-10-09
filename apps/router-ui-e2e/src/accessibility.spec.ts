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
  offers: Partial<{
    bootstrap: boolean;
    github: boolean;
    google: boolean;
    magicLink: boolean;
    password: boolean;
    passwordMinLength: number;
    inviteRequired: boolean;
  }>,
): Promise<void> {
  await mockGraphQL(page, {
    SignInOptions: {
      signInOptions: {
        __typename: 'SignInOptions',
        bootstrap: false,
        github: true,
        google: true,
        magicLink: false,
        password: false,
        passwordMinLength: 12,
        passwordReset: false,
        inviteRequired: false,
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

  test('the sign-up screen has no serious axe violations', async ({ page }) => {
    // The screen everyone after the first account uses on a mailer-less
    // deployment, and the only one in the console with two labelled secrets.
    await signInOptions(page, { github: false, google: false, password: true });

    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();

    const violations = await auditPage(page);
    expect(violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))).toEqual([]);
  });

  test('the component gallery has no serious axe violations', async ({ page }) => {
    await page.goto('/dev/components');
    await expect(page.getByRole('heading', { level: 1, name: 'Components' })).toBeVisible();

    const violations = await auditPage(page);
    expect(violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))).toEqual([]);
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`the attestation inspector has no serious axe violations in ${theme} mode`, async ({ page }) => {
      /*
       * Audited at `/dev/attestation` rather than on the chat screen, because the
       * populated panel cannot exist here: tier 1 needs Web Crypto, this suite
       * serves a named http origin on purpose (`origins.ts`), and browsers
       * withhold Web Crypto from one. The review route hands the real component
       * the result the component tests use, so what is audited is the panel with
       * a graph, a dozen digests and a full measurements list in it.
       */
      await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
      await page.goto('/dev/attestation');
      await page.getByRole('button', { name: 'Inspect attestation' }).first().click();

      const dialog = page.getByRole('dialog', { name: /Attestation for this endpoint/i });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('tab', { name: 'Deployment graph' }).click();
      await expect(dialog.getByRole('button', { name: /^Ingress host/ }).first()).toBeVisible();

      const violations = await auditPage(page);
      expect(violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))).toEqual([]);
    });
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`the external upstream panel has no serious axe violations in ${theme} mode`, async ({ page }) => {
      /*
       * The same panel in its external mode (SUP-227): different headings,
       * different provenance copy, a graph with nothing to compare against. It
       * is audited from the review route for the reason above and one more —
       * reaching it for real needs an upstream this stand has a verdict for,
       * which is a sidecar and therefore SUP-229's stand rather than this suite's.
       */
      await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
      await page.goto('/dev/attestation');
      await page.getByRole('button', { name: 'Inspect upstream attestation' }).click();

      const dialog = page.getByRole('dialog', { name: /Attestation for this external upstream/i });
      await expect(dialog).toBeVisible();
      // The provenance line the issue requires: through this router's relay, and
      // whose publication it is.
      await expect(dialog.getByText(/this router’s relay of/)).toBeVisible();
      await dialog.getByRole('tab', { name: 'Deployment graph' }).click();
      await expect(dialog.getByRole('button', { name: /^Ingress host/ }).first()).toBeVisible();

      const violations = await auditPage(page);
      expect(violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))).toEqual([]);
    });
  }

  test('the deployment graph is walkable with the keyboard, node by node', async ({ page }) => {
    await page.goto('/dev/attestation');
    await page.getByRole('button', { name: 'Inspect attestation' }).first().click();

    const dialog = page.getByRole('dialog', { name: /Attestation for this endpoint/i });
    await dialog.getByRole('tab', { name: 'Deployment graph' }).click();

    const first = dialog.getByRole('button', { name: /^Ingress host/ }).first();
    await expect(first).toBeVisible();
    await first.focus();

    /*
     * Tab order has to be the order the panel says it is — hosts, services, then
     * each workload followed by its own containers — because a reader who cannot
     * see the columns has only that sentence to go on. Depth rather than column
     * on purpose: having just heard a workload's name, the useful next thing is
     * what that workload runs.
     */
    const visited: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      const name = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
      if (name) visited.push(name);
      await page.keyboard.press('Tab');
    }

    // Twelve nodes, every one a tab stop: two ingress hosts, three services,
    // then each workload trailed by the containers it runs — litellm with one,
    // router-api with its init container and its own, router-ui with one.
    expect(visited.map((name) => name.split(' ')[0])).toEqual([
      'Ingress',
      'Ingress',
      'Service',
      'Service',
      'Service',
      'Workload',
      'Container',
      'Workload',
      'Container',
      'Container',
      'Workload',
      'Container',
    ]);

    // And Enter on a node opens its raw signed fields, without a pointer.
    const container = dialog.getByRole('button', { name: /^Container router-api/ }).first();
    await container.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'router-api' }).getByText(/signed snapshot/)).toBeVisible();
  });

  test('an undeclared image is named in words, not only in red', async ({ page }) => {
    // The one claim on this panel a reader cannot check by eye. A colour is not a
    // statement, so the accessible name of the node carries the verdict too.
    await page.goto('/dev/attestation');
    await page.getByRole('button', { name: 'Inspect attestation' }).nth(1).click();

    const dialog = page.getByRole('dialog', { name: /Attestation for this endpoint/i });
    await dialog.getByRole('tab', { name: 'Deployment graph' }).click();

    await expect(dialog.getByText(/runs an image the operator did not declare/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Container router-ui.*undeclared/s })).toBeVisible();
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
