import { expect, test } from '@playwright/test';
import { CONSOLE_OPERATIONS } from './evidence-fixtures';
import { mockGraphQL, signIn } from './fixtures';

test.describe('sign-in', () => {
  test('sends a signed-out visitor to the sign-in screen and remembers the destination', async ({ page }) => {
    await page.goto('/logs');

    await expect(page).toHaveURL(/\/login\?next=%2Flogs$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('offers both providers and the magic link', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('button', { name: /Continue with GitHub/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
  });

  test('mails a magic link and confirms it was sent', async ({ page }) => {
    let requestBody: unknown;
    await page.route('**/auth/sign-in/magic-link', async (route) => {
      requestBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/login');
    await page.getByLabel('Email').fill('developer@example.com');
    await page.getByRole('button', { name: 'Email me a link' }).click();

    await expect(page.getByText('Check your inbox')).toBeVisible();
    expect(requestBody).toMatchObject({ email: 'developer@example.com' });
  });

  test('follows a provider redirect', async ({ page }) => {
    await page.route('**/auth/sign-in/social', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'http://127.0.0.1:4300/login?provider=github' }),
      });
    });

    await page.goto('/login');
    await page.getByRole('button', { name: /Continue with GitHub/ }).click();

    await expect(page).toHaveURL(/provider=github/);
  });

  test('signs in and lands on Overview', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, CONSOLE_OPERATIONS);

    await page.goto('/login');

    // A live session on the sign-in screen bounces to the console.
    await expect(page).toHaveURL(`${baseURL}/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Console' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Account: Dev Eloper/ })).toBeVisible();
    await expect(page.getByText('$170.65')).toBeVisible();
  });

  test('navigates between console screens', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, CONSOLE_OPERATIONS);
    await page.goto('/');

    // Scoped to the sidebar: the Overview also links to API Keys from its
    // shortcut cards, and this test is about the navigation landmark.
    const sidebar = page.getByRole('navigation', { name: 'Console' });
    await sidebar.getByRole('link', { name: 'API Keys' }).click();

    await expect(page).toHaveURL(`${baseURL}/keys`);
    await expect(page.getByRole('heading', { level: 1, name: 'API Keys' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'API Keys' })).toHaveAttribute('aria-current', 'page');
  });

  test('shows an unknown console URL as not found', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, CONSOLE_OPERATIONS);

    await page.goto('/nope');

    await expect(page.getByText('Page not found')).toBeVisible();
  });

  test('renders the component gallery without a session', async ({ page }) => {
    await mockGraphQL(page);

    await page.goto('/dev/components');

    await expect(page.getByRole('heading', { level: 1, name: 'Components' })).toBeVisible();
  });
});
