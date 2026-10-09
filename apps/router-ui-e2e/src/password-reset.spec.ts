import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { mockGraphQL, SESSION_DATA, SIGNED_IN_COOKIE_NAME, UNAUTHENTICATED } from './fixtures';
import { CONSOLE_ORIGIN } from './origins';

/**
 * Password reset in the console (SUP-269): the "Forgot password?" entry point,
 * the request screen and the page a reset mail links to. The router is mocked;
 * `apps/router-api/test/password-reset.e2e.spec.ts` drives the real one.
 *
 * `PLAYWRIGHT_SCREENSHOTS=<dir>` writes a screenshot of each screen there, which
 * is how the PR's images are produced.
 */
async function deployment(page: Page, passwordReset: boolean, signedIn = false): Promise<void> {
  await mockGraphQL(page, {
    SignedIn: signedIn ? { me: { id: SESSION_DATA.me.id } } : UNAUTHENTICATED,
    SignInOptions: {
      signInOptions: {
        __typename: 'SignInOptions',
        bootstrap: false,
        github: false,
        google: false,
        magicLink: false,
        password: true,
        passwordMinLength: 12,
        passwordReset,
        inviteRequired: false,
      },
    },
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  const dir = process.env.PLAYWRIGHT_SCREENSHOTS;
  if (dir) {
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
  }
}

test.describe('password reset', () => {
  test('is offered from the sign-in screen where the router can mail a link', async ({ page }) => {
    await deployment(page, true);
    await page.goto('/login');

    await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeVisible();
    await shoot(page, 'login-forgot-link');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  });

  test('is not offered on a deployment with no mailer', async ({ page }) => {
    await deployment(page, false);
    await page.goto('/login');

    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeHidden();
  });

  test('requests a link and confirms without saying whether the account exists', async ({ page }) => {
    await deployment(page, true);
    let body: unknown;
    await page.route('**/auth/request-password-reset', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":true}' });
    });

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill('someone@example.com');
    await shoot(page, 'forgot-password');
    await page.getByRole('button', { name: 'Email me a reset link' }).click();

    await expect(page.getByText(/has an account here, a reset link is on its way/)).toBeVisible();
    await shoot(page, 'forgot-password-sent');
    expect(body).toEqual({ email: 'someone@example.com' });
  });

  test('sets a new password from the mailed link, even in a signed-in browser', async ({ page }) => {
    await deployment(page, true, true);
    // A browser that is signed in — to this account or another — must not be
    // bounced to the console and lose the token.
    await page.context().addCookies([{ name: SIGNED_IN_COOKIE_NAME, value: '1', url: CONSOLE_ORIGIN }]);
    let body: unknown;
    await page.route('**/auth/reset-password', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":true}' });
    });

    await page.goto('/reset-password?token=tok123');
    await expect(page).toHaveURL(/\/reset-password\?token=tok123$/);
    await page.getByLabel('New password').fill('a-brand-new-password');
    await page.getByLabel('Repeat it').fill('a-brand-new-password');
    await shoot(page, 'reset-password');
    await page.getByRole('button', { name: 'Set new password' }).click();

    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
    await shoot(page, 'reset-password-done');
    expect(body).toEqual({ token: 'tok123', newPassword: 'a-brand-new-password' });
  });

  test('explains a used or expired link', async ({ page }) => {
    await deployment(page, true);
    await page.route('**/auth/reset-password', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'INVALID_TOKEN', message: 'Invalid token' }),
      });
    });

    await page.goto('/reset-password?token=spent');
    await page.getByLabel('New password').fill('a-brand-new-password');
    await page.getByLabel('Repeat it').fill('a-brand-new-password');
    await page.getByRole('button', { name: 'Set new password' }).click();

    await expect(page.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();
    await shoot(page, 'reset-password-dead-link');
    await expect(page.getByRole('link', { name: 'Send a new link' })).toHaveAttribute('href', '/forgot-password');
  });
});
