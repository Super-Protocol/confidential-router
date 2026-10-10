import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signIn, viewerIsAdmin } from './fixtures';

/**
 * The admin Invitations section in a browser (SUP-268): the gate, the three
 * tabs, and an axe audit of each in both themes — the bar `admin.spec.ts` holds
 * the other admin screens to. The live round trip (issue → redeem → see it) is
 * `cross-app.spec.ts`; this one is the screen against fixtures.
 */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

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

const CODE = 'ABCD-EFGH-JKMN';

function day(date: string, values: Record<string, number> = {}) {
  return {
    __typename: 'InviteDay',
    date,
    codesIssued: 0,
    codesRedeemed: 0,
    signUpsInvited: 0,
    signUpsBootstrap: 0,
    signUpsOpen: 0,
    ...values,
  };
}

const INVITATION_OPERATIONS = {
  InviteStatistics: (variables: Record<string, unknown>) => ({
    inviteStatistics: {
      __typename: 'InviteStatistics',
      totals: {
        __typename: 'InviteTotals',
        issued: 51,
        redeemed: 3,
        withdrawn: 1,
        redemptionRate: 3 / 51,
        grantedMicros: '300000000',
        signUps: 5,
      },
      daily: Array.from({ length: Number(variables.days) }, (_, index) => {
        const date = new Date(Date.UTC(2026, 9, 9) - (Number(variables.days) - 1 - index) * 86_400_000)
          .toISOString()
          .slice(0, 10);
        return index === Number(variables.days) - 2
          ? day(date, { codesIssued: 51, signUpsBootstrap: 1 })
          : index === Number(variables.days) - 1
            ? day(date, { codesRedeemed: 3, signUpsInvited: 3, signUpsOpen: 1 })
            : day(date);
      }),
      campaigns: [
        {
          __typename: 'InviteCampaignStats',
          campaign: 'launch-2026-10',
          issued: 50,
          redeemed: 3,
          redemptionRate: 0.06,
          activated: 2,
          grantedMicros: '300000000',
        },
        {
          __typename: 'InviteCampaignStats',
          campaign: 'vip',
          issued: 1,
          redeemed: 0,
          redemptionRate: 0,
          activated: 0,
          grantedMicros: '0',
        },
      ],
    },
  }),
  AdminInviteCodes: {
    adminInviteCodes: {
      __typename: 'AdminInviteCodePage',
      totalCount: 2,
      nodes: [
        {
          __typename: 'AdminInviteCode',
          id: 'code-1',
          code: CODE,
          url: `https://router.superprotocol.com/?invite=${CODE}`,
          campaign: 'launch-2026-10',
          grantMicros: '100000000',
          maxRedemptions: 1,
          redemptionCount: 1,
          status: 'REDEEMED',
          createdAt: '2026-10-08T10:00:00.000Z',
          expiresAt: null,
          withdrawnAt: null,
          note: null,
          issuedByEmail: 'ops@example.com',
          redeemers: [
            {
              __typename: 'InviteCodeRedeemer',
              userId: 'u-2',
              email: 'dev@example.com',
              redeemedAt: '2026-10-09T09:00:00.000Z',
            },
          ],
        },
        {
          __typename: 'AdminInviteCode',
          id: 'code-2',
          code: 'PQRS-TVWX-YZ23',
          url: 'https://router.superprotocol.com/?invite=PQRS-TVWX-YZ23',
          campaign: 'vip',
          grantMicros: '250000000',
          maxRedemptions: 1,
          redemptionCount: 0,
          status: 'ACTIVE',
          createdAt: '2026-10-08T11:00:00.000Z',
          expiresAt: '2026-12-31T00:00:00.000Z',
          withdrawnAt: null,
          note: 'For the keynote',
          issuedByEmail: null,
          redeemers: [],
        },
      ],
    },
  },
  AdminSignUps: {
    adminSignUps: {
      __typename: 'AdminSignUpPage',
      totalCount: 2,
      nodes: [
        {
          __typename: 'AdminSignUp',
          userId: 'u-2',
          email: 'dev@example.com',
          createdAt: '2026-10-09T09:00:00.000Z',
          origin: 'INVITE',
          inviteCodeId: 'code-1',
          inviteCode: CODE,
          campaign: 'launch-2026-10',
          redeemedAt: '2026-10-09T09:00:00.000Z',
        },
        {
          __typename: 'AdminSignUp',
          userId: 'u-1',
          email: 'admin@example.com',
          createdAt: '2026-10-08T09:00:00.000Z',
          origin: 'BOOTSTRAP',
          inviteCodeId: null,
          inviteCode: null,
          campaign: null,
          redeemedAt: null,
        },
      ],
    },
  },
};

async function openAsAdmin(page: Page, baseURL: string, theme: 'light' | 'dark' = 'dark'): Promise<void> {
  await signIn(page, baseURL, { ViewerIsAdmin: viewerIsAdmin(true), ...INVITATION_OPERATIONS });
  await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
  await page.goto('/admin/invitations');
  await expect(page.getByRole('heading', { level: 1, name: 'Invitations' })).toBeVisible();
}

test.describe('the Invitations section', () => {
  test('is in the Administration group for an administrator', async ({ page, baseURL }) => {
    await openAsAdmin(page, baseURL as string);

    await expect(page.getByRole('link', { name: 'Invitations' })).toBeVisible();
  });

  test('is neither in the sidebar nor on the page for a member', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, INVITATION_OPERATIONS);
    await page.goto('/admin/invitations');

    await expect(page.getByTestId('invitations-restricted')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Invitations' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Issue codes' })).toHaveCount(0);
  });

  test('masks every code until an operator reveals one', async ({ page, baseURL }) => {
    await openAsAdmin(page, baseURL as string);
    await page.getByRole('tab', { name: 'Codes' }).click();

    const table = page.getByRole('table', { name: 'Invitation codes' });
    await expect(table).toContainText('ABCD-••••-••••');
    await expect(table).not.toContainText(CODE);
    await table.getByRole('button', { name: 'Reveal code ABCD-••••-••••' }).click();
    await expect(table).toContainText(CODE);
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`has no serious axe violations on any tab, or in the issue dialog, in ${theme} mode`, async ({
      page,
      baseURL,
    }) => {
      await openAsAdmin(page, baseURL as string, theme);
      await expect(page.getByText('Sign-ups per day, by origin')).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);

      await page.getByRole('tab', { name: 'Codes' }).click();
      await expect(page.getByRole('table', { name: 'Invitation codes' })).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);

      await page.getByRole('tab', { name: 'Sign-ups' }).click();
      await expect(page.getByRole('table', { name: 'Sign-ups' })).toBeVisible();
      expect(await blockingViolations(page)).toEqual([]);

      await page.getByRole('button', { name: 'Issue codes' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      // Audited once the open animation has finished: mid-fade, every colour in
      // the dialog is a blend with the overlay and fails contrast for a frame.
      await dialog.evaluate((element) =>
        Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
      );
      expect(await blockingViolations(page)).toEqual([]);
    });
  }
});
