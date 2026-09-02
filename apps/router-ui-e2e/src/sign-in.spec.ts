import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { CONSOLE_OPERATIONS } from './evidence-fixtures';
import {
  type GraphQLFixtures,
  mockGraphQL,
  SESSION_COOKIE_NAME,
  SESSION_DATA,
  SIGNED_IN_COOKIE_NAME,
  signIn,
  UNAUTHENTICATED,
} from './fixtures';
import { API_ORIGIN, CONSOLE_ORIGIN } from './origins';

/**
 * The screen asks the API which sign-in paths this deployment offers before it
 * renders any of them, so every case here has to say what it is a deployment
 * of. The default is the development one: both OAuth apps, a mailer, and no
 * bootstrap window because somebody has already signed in.
 */
type Offers = Partial<{
  bootstrap: boolean;
  github: boolean;
  google: boolean;
  magicLink: boolean;
  password: boolean;
  passwordMinLength: number;
}>;

async function deployment(page: Page, offers: Offers = {}, operations: GraphQLFixtures = {}): Promise<void> {
  await mockGraphQL(page, {
    ...operations,
    SignInOptions: {
      signInOptions: {
        __typename: 'SignInOptions',
        bootstrap: false,
        github: true,
        google: true,
        magicLink: true,
        password: false,
        passwordMinLength: 12,
        ...offers,
      },
    },
  });
}

/**
 * The cookie router-api leaves on its *own* host after a successful sign-in.
 *
 * Placed rather than sent as a `Set-Cookie` header on the fulfilled response:
 * Playwright does not apply one from a fulfilled route, so a header there only
 * looks like a session. Which is a fair summary of how SUP-113 got through.
 */
async function apiSetsSession(page: Page, value: string): Promise<void> {
  await page
    .context()
    .addCookies([{ name: SESSION_COOKIE_NAME, value, url: API_ORIGIN, httpOnly: true, sameSite: 'Lax' }]);
}

/** A marketplace install: no mailer, no OAuth app, passwords on. */
const MAILER_LESS: Offers = { github: false, google: false, magicLink: false, password: true };

/** The same deployment, as a fixture a spec can merge into its own mocks. */
const SIGN_IN_OPTIONS = {
  signInOptions: {
    __typename: 'SignInOptions',
    bootstrap: false,
    github: false,
    google: false,
    magicLink: false,
    password: true,
    passwordMinLength: 12,
  },
};

test.describe('sign-in', () => {
  test('sends a signed-out visitor to the sign-in screen and remembers the destination', async ({ page }) => {
    await deployment(page);

    await page.goto('/logs');

    await expect(page).toHaveURL(/\/login\?next=%2Flogs$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('offers both providers and the magic link', async ({ page }) => {
    await deployment(page);

    await page.goto('/login');

    await expect(page.getByRole('button', { name: /Continue with GitHub/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Have a bootstrap token?' })).toBeHidden();
  });

  test('mails a magic link and confirms it was sent', async ({ page }) => {
    await deployment(page);
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
    await deployment(page);
    await page.route('**/auth/sign-in/social', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: `${CONSOLE_ORIGIN}/login?provider=github` }),
      });
    });

    await page.goto('/login');
    await page.getByRole('button', { name: /Continue with GitHub/ }).click();

    await expect(page).toHaveURL(/provider=github/);
  });

  test('offers only the bootstrap path on a fresh deployment with no mailer or OAuth app', async ({ page }) => {
    await deployment(page, { bootstrap: true, github: false, google: false, magicLink: false });

    await page.goto('/login');

    await expect(page.getByRole('button', { name: /Continue with/ })).toBeHidden();
    await expect(page.getByLabel('Email')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Have a bootstrap token?' })).toBeVisible();
  });

  test('trades a bootstrap token for a session and lands on the console', async ({ page, baseURL }) => {
    await deployment(page, { bootstrap: true, github: false, google: false, magicLink: false });
    let requestBody: unknown;
    await page.route('**/auth/bootstrap', async (route) => {
      requestBody = route.request().postDataJSON();
      // What the router does on success: the session arrives as a cookie.
      await apiSetsSession(page, 'e2e-bootstrap-session');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: { id: 'user-1', email: 'admin@example.com' } }),
      });
    });

    await page.goto('/login');
    await page.getByRole('button', { name: 'Have a bootstrap token?' }).click();
    await page.getByLabel('Bootstrap token').fill('bootstrap-token-32-characters-ok');
    await page.getByRole('button', { name: 'Create the first account' }).click();

    expect(requestBody).toEqual({ token: 'bootstrap-token-32-characters-ok' });
    await expect(page).toHaveURL(`${baseURL}/`);
  });

  test('says a deployment that has already been set up is not bootstrappable', async ({ page }) => {
    await deployment(page, { bootstrap: true, github: false, google: false, magicLink: false });
    await page.route('**/auth/bootstrap', async (route) => {
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/login');
    await page.getByRole('button', { name: 'Have a bootstrap token?' }).click();
    await page.getByLabel('Bootstrap token').fill('bootstrap-token-32-characters-ok');
    await page.getByRole('button', { name: 'Create the first account' }).click();

    // By id, not by role: Next's route announcer is also `role="alert"`.
    await expect(page.locator('#bootstrap-error')).toContainText('already has an account');
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

  test('asks for a password on a deployment that offers one', async ({ page }) => {
    await deployment(page, MAILER_LESS);

    await page.goto('/login');

    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a link' })).toBeHidden();
  });

  test('signs in with a password and lands on the console', async ({ page, baseURL }) => {
    await deployment(page, MAILER_LESS);
    let requestBody: unknown;
    await page.route('**/auth/sign-in/email', async (route) => {
      requestBody = route.request().postDataJSON();
      await apiSetsSession(page, 'e2e-password-session');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: { id: 'user-1', email: 'developer@example.com' } }),
      });
    });

    await page.goto('/login');
    await page.getByLabel('Email').fill('developer@example.com');
    await page.getByLabel('Password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Sign in' }).click();

    expect(requestBody).toMatchObject({ email: 'developer@example.com', password: 'correct-horse-battery' });
    await expect(page).toHaveURL(`${baseURL}/`);
  });

  test('explains a rejected email and password without naming which half', async ({ page }) => {
    await deployment(page, MAILER_LESS);
    await page.route('**/auth/sign-in/email', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Invalid email or password' }),
      });
    });

    await page.goto('/login');
    await page.getByLabel('Email').fill('developer@example.com');
    await page.getByLabel('Password').fill('wrong-password-here');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // By id, not by role: Next's route announcer is also `role="alert"`.
    await expect(page.locator('#sign-in-error')).toContainText('do not match an account here');
  });

  test('creates an account from the sign-up screen and lands on the console', async ({ page, baseURL }) => {
    await deployment(page, MAILER_LESS);
    let requestBody: unknown;
    await page.route('**/auth/sign-up/email', async (route) => {
      requestBody = route.request().postDataJSON();
      await apiSetsSession(page, 'e2e-signup-session');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: { id: 'user-2', email: 'newcomer@example.com' } }),
      });
    });

    await page.goto('/login');
    await page.getByRole('link', { name: 'Create one' }).click();
    await expect(page).toHaveURL(/\/signup$/);

    await page.getByLabel('Name (optional)').fill('New Comer');
    await page.getByLabel('Email').fill('newcomer@example.com');
    await page.getByLabel('Password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Create account' }).click();

    // No inbox in between: the session arrives with the sign-up itself.
    expect(requestBody).toMatchObject({ email: 'newcomer@example.com', name: 'New Comer' });
    await expect(page).toHaveURL(`${baseURL}/`);
  });

  test('says so on a deployment that does not offer password sign-up', async ({ page }) => {
    await deployment(page);

    await page.goto('/signup');

    await expect(page.getByText('does not offer password sign-up')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeHidden();
  });

  test('renders the component gallery without a session', async ({ page }) => {
    await mockGraphQL(page);

    await page.goto('/dev/components');

    await expect(page.getByRole('heading', { level: 1, name: 'Components' })).toBeVisible();
  });
});

/**
 * The console and router-api are on different hostnames here, as they are on
 * every deployment (`origins.ts`). These are the flows that only exist because
 * of that split — the ones that all passed while the console was gating on a
 * cookie it could never see (SUP-113).
 */
test.describe('sign-in, across two hostnames', () => {
  /** What a password sign-in gets: an answer, and a cookie on the API's host. */
  async function apiSignsIn(page: Page): Promise<void> {
    await page.route('**/auth/sign-in/email', async (route) => {
      await apiSetsSession(page, 'e2e-cross-host-session');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: { id: 'user-1', email: 'developer@example.com' } }),
      });
    });
  }

  async function submitPassword(page: Page): Promise<void> {
    await page.getByLabel('Email').fill('developer@example.com');
    await page.getByLabel('Password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  test('leaves the session cookie on the API host and the routing marker on the console\u2019s', async ({ page }) => {
    await deployment(page, MAILER_LESS);
    await apiSignsIn(page);

    await page.goto('/login');
    await submitPassword(page);
    await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/`);

    const named = async (origin: string) => (await page.context().cookies(origin)).map((cookie) => cookie.name);
    // The console cannot read the API's cookie \u2014 not on a deployment, and no
    // longer here either. Its own marker is what got the browser through.
    expect(await named(API_ORIGIN)).toContain(SESSION_COOKIE_NAME);
    expect(await named(CONSOLE_ORIGIN)).not.toContain(SESSION_COOKIE_NAME);
    expect(await named(CONSOLE_ORIGIN)).toContain(SIGNED_IN_COOKIE_NAME);
  });

  test('stays signed in across a reload', async ({ page }) => {
    await deployment(page, MAILER_LESS, CONSOLE_OPERATIONS);
    await apiSignsIn(page);

    await page.goto('/login');
    await submitPassword(page);
    await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/`);

    await page.reload();

    await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  });

  test('comes back to the deep link that sent the viewer to the sign-in screen', async ({ page }) => {
    await deployment(page, MAILER_LESS, CONSOLE_OPERATIONS);
    await apiSignsIn(page);

    await page.goto('/models');
    await expect(page).toHaveURL(/\/login\?next=%2Fmodels$/);

    await submitPassword(page);

    await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/models`);
    await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  });

  test('lets a session that arrived by redirect in, instead of looping', async ({ page }) => {
    // A magic link and an OAuth callback both come back from router-api without
    // running any console code, so nothing raised the marker: the proxy sends
    // the browser to `/login` with a live session it cannot see. The sign-in
    // screen asks the API, and that is what breaks the loop.
    await deployment(page, MAILER_LESS, { ...CONSOLE_OPERATIONS, SignedIn: { me: { id: SESSION_DATA.me.id } } });
    await page.context().addCookies([{ name: SESSION_COOKIE_NAME, value: 'e2e-redirect-session', url: API_ORIGIN }]);

    await page.goto('/');

    await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  });

  test('signs out and is bounced off the console', async ({ page, baseURL }) => {
    let session = true;
    await page.route('**/auth/sign-out', async (route) => {
      session = false;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await signIn(page, baseURL as string, {
      ...CONSOLE_OPERATIONS,
      SignInOptions: SIGN_IN_OPTIONS,
      // The API stops answering the moment it has ended the session, which is
      // what keeps the sign-in screen from letting the browser straight back in.
      Session: () => (session ? SESSION_DATA : UNAUTHENTICATED),
      SignedIn: () => (session ? { me: { id: SESSION_DATA.me.id } } : UNAUTHENTICATED),
    });

    await page.goto('/');
    await page.getByRole('button', { name: /Account: Dev Eloper/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/login$/);
    const named = (await page.context().cookies(CONSOLE_ORIGIN)).map((cookie) => cookie.name);
    expect(named).not.toContain(SIGNED_IN_COOKIE_NAME);

    // And it stays bounced: the console is not reachable again without one.
    await page.goto('/keys');
    await expect(page).toHaveURL(/\/login\?next=%2Fkeys$/);
  });
});
