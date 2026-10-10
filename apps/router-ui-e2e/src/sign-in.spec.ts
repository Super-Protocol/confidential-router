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
 * of. The default is the development one: both OAuth apps, a mailer — so a code
 * can be mailed, and a link beside it — and no bootstrap window because somebody
 * has already signed in.
 */
type Offers = Partial<{
  bootstrap: boolean;
  adminRecovery: boolean;
  github: boolean;
  google: boolean;
  emailCode: boolean;
  emailCodeLength: number;
  magicLink: boolean;
  inviteRequired: boolean;
}>;

async function deployment(page: Page, offers: Offers = {}, operations: GraphQLFixtures = {}): Promise<void> {
  await mockGraphQL(page, {
    ...operations,
    SignInOptions: {
      signInOptions: {
        __typename: 'SignInOptions',
        bootstrap: false,
        adminRecovery: false,
        github: true,
        google: true,
        emailCode: true,
        emailCodeLength: 6,
        magicLink: true,
        inviteRequired: false,
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

/** A production deployment with a mailer and no OAuth app: a mailed code, and nothing else. */
const CODE_ONLY: Offers = { github: false, google: false, magicLink: false };

/** A marketplace install before anyone configured a mailer: the token is the only way in. */
const MAILER_LESS: Offers = { github: false, google: false, emailCode: false, magicLink: false };

/** The code-only deployment, as a fixture a spec can merge into its own mocks. */
const SIGN_IN_OPTIONS = {
  signInOptions: {
    __typename: 'SignInOptions',
    bootstrap: false,
    adminRecovery: false,
    github: false,
    google: false,
    emailCode: true,
    emailCodeLength: 6,
    magicLink: false,
    inviteRequired: false,
  },
};

/** The code every mocked mail "carries". */
const MAILED_CODE = '482913';

/**
 * The router's two email-code routes, mocked: one mails a code to any address,
 * the other trades it for a session — creating the account if the address has
 * none, which is why this is the sign-up as well.
 *
 * `refusal` answers the second route instead; `session` is the cookie value the
 * API leaves on its own host when it does sign the browser in.
 */
async function mockEmailCode(
  page: Page,
  { session = 'e2e-code-session', refusal }: { session?: string; refusal?: { status: number; code: string } } = {},
): Promise<{ requested: unknown[]; submitted: unknown[] }> {
  const requested: unknown[] = [];
  const submitted: unknown[] = [];
  await page.route('**/auth/email-otp/send-verification-otp', async (route) => {
    requested.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });
  await page.route('**/auth/sign-in/email-otp', async (route) => {
    submitted.push(route.request().postDataJSON());
    if (refusal) {
      await route.fulfill({
        status: refusal.status,
        contentType: 'application/json',
        body: JSON.stringify({ code: refusal.code, message: 'refused' }),
      });
      return;
    }
    // What the router does on success: the session arrives as a cookie.
    await apiSetsSession(page, session);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: session, user: { id: 'user-1', email: 'developer@example.com' } }),
    });
  });
  return { requested, submitted };
}

/** The first step of the code path: an address, and a code asked for. */
async function askForCode(page: Page, email = 'developer@example.com'): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
}

/** Both steps, ending on the press of "Sign in". */
async function signInByCode(page: Page, code = MAILED_CODE): Promise<void> {
  await askForCode(page);
  await page.getByLabel('Code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * Screenshots for a review, on request: `PLAYWRIGHT_SCREENSHOTS=<dir>` writes
 * the sign-in and sign-up steps there as PNGs, the way `PLAYWRIGHT_VIDEO=on`
 * records the flows. Unset — which is every ordinary run — this does nothing.
 */
const SCREENSHOT_DIR = process.env.PLAYWRIGHT_SCREENSHOTS;

async function capture(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

test.describe('sign-in', () => {
  test('sends a signed-out visitor to the sign-in screen and remembers the destination', async ({ page }) => {
    await deployment(page);

    await page.goto('/logs');

    await expect(page).toHaveURL(/\/login\?next=%2Flogs$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('offers both providers and an address to mail', async ({ page }) => {
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
    // The link is the alternative where a deployment mails both: a code signs
    // in the browser the viewer is looking at.
    await page.getByRole('button', { name: 'Email me a link instead' }).click();
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
    await deployment(page, { ...MAILER_LESS, bootstrap: true });

    await page.goto('/login');

    await expect(page.getByRole('button', { name: /Continue with/ })).toBeHidden();
    await expect(page.getByLabel('Email')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Have a bootstrap token?' })).toBeVisible();
  });

  test('trades a bootstrap token for a session and lands on the console', async ({ page, baseURL }) => {
    await deployment(page, { ...MAILER_LESS, bootstrap: true });
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
    await deployment(page, { ...MAILER_LESS, bootstrap: true });
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

  test('asks for an address and no password', async ({ page }) => {
    await deployment(page, CODE_ONLY);

    await page.goto('/login');

    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a code' })).toBeVisible();
    await expect(page.getByLabel(/password/i)).toHaveCount(0);
    await expect(page.getByRole('link', { name: /forgot/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Email me a link/ })).toBeHidden();
    await capture(page, 'login-email');
  });

  test('mails a code, then signs in with it and lands on the console', async ({ page, baseURL }) => {
    await deployment(page, CODE_ONLY);
    const { requested, submitted } = await mockEmailCode(page);

    await page.goto('/login');
    await askForCode(page);

    expect(requested).toEqual([{ email: 'developer@example.com', type: 'sign-in' }]);
    // Says where the code went, and nothing about whether an account was there.
    await expect(
      page.getByText('We sent a 6-digit code to developer@example.com. It works once and expires in a few minutes.'),
    ).toBeVisible();
    const field = page.getByLabel('Code', { exact: true });
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(field).toHaveAttribute('inputmode', 'numeric');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    await capture(page, 'login-code');

    await field.fill(MAILED_CODE);
    await page.getByRole('button', { name: 'Sign in' }).click();

    expect(submitted).toEqual([{ email: 'developer@example.com', otp: MAILED_CODE }]);
    await expect(page).toHaveURL(`${baseURL}/`);
  });

  test('says a wrong code is wrong and keeps the viewer on the code step', async ({ page }) => {
    await deployment(page, CODE_ONLY);
    await mockEmailCode(page, { refusal: { status: 400, code: 'INVALID_OTP' } });

    await page.goto('/login');
    await signInByCode(page, '000000');

    // By id, not by role: Next's route announcer is also `role="alert"`.
    await expect(page.locator('#email-code-error')).toContainText('That code is not right');
    await expect(page).toHaveURL(/\/login$/);
    const named = (await page.context().cookies(CONSOLE_ORIGIN)).map((cookie) => cookie.name);
    expect(named).not.toContain(SIGNED_IN_COOKIE_NAME);
  });

  for (const code of ['OTP_EXPIRED', 'TOO_MANY_ATTEMPTS']) {
    test(`says a dead code is dead and mails a new one on request: ${code}`, async ({ page }) => {
      await deployment(page, CODE_ONLY);
      const { requested } = await mockEmailCode(page, { refusal: { status: 400, code } });

      await page.goto('/login');
      await signInByCode(page);

      await expect(page.locator('#email-code-error')).toContainText('That code no longer works. Send a new one.');
      // Emptied, so the only button left to press is the one that helps.
      await expect(page.getByLabel('Code', { exact: true })).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();

      await page.getByRole('button', { name: 'Send a new code' }).click();

      await expect(page.getByTestId('email-code-resent')).toBeVisible();
      expect(requested).toHaveLength(2);
    });
  }

  test('tells a throttled request for a code to wait', async ({ page }) => {
    await deployment(page, CODE_ONLY);
    await page.route('**/auth/email-otp/send-verification-otp', async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'RATE_LIMITED', message: 'Too many sign-in codes requested.' }),
      });
    });

    await page.goto('/login');
    await page.getByLabel('Email').fill('developer@example.com');
    await page.getByRole('button', { name: 'Email me a code' }).click();

    await expect(page.locator('#sign-in-error')).toContainText('Too many attempts. Wait a minute and try again.');
    await expect(page.getByLabel('Code', { exact: true })).toBeHidden();
  });

  test('goes back from the code step for a different address', async ({ page }) => {
    await deployment(page, CODE_ONLY);
    await mockEmailCode(page);

    await page.goto('/login');
    await askForCode(page);
    await page.getByRole('button', { name: 'Use a different address' }).click();

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveValue('developer@example.com');
  });

  test('offers the administrator the first-sign-in token once the deployment has been claimed', async ({
    page,
    baseURL,
  }) => {
    // The token's second job (SUP-269): the account it created exists, and the
    // token signs that one account back in when no code can reach it.
    await deployment(page, { ...CODE_ONLY, adminRecovery: true });
    let requestBody: unknown;
    await page.route('**/auth/bootstrap', async (route) => {
      requestBody = route.request().postDataJSON();
      await apiSetsSession(page, 'e2e-recovery-session');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: { id: 'user-1', email: 'admin@example.com' } }),
      });
    });

    await page.goto('/login');
    const recovery = page.getByRole('button', { name: 'Administrator: use the first-sign-in token' });
    await expect(recovery).toBeVisible();
    // Not the first-sign-in offer: nothing is left to set up.
    await expect(page.getByRole('button', { name: 'Have a bootstrap token?' })).toBeHidden();
    await capture(page, 'login-admin-recovery');

    await recovery.click();
    await expect(page.getByRole('heading', { name: 'Administrator sign-in' })).toBeVisible();
    await expect(page.getByText(/creates the first account/)).toHaveCount(0);
    await page.getByLabel('First-sign-in token').fill('bootstrap-token-32-characters-ok');
    await page.getByRole('button', { name: 'Sign in as administrator' }).click();

    expect(requestBody).toEqual({ token: 'bootstrap-token-32-characters-ok' });
    await expect(page).toHaveURL(`${baseURL}/`);
  });

  test('does not offer the administrator token where the API does not report it', async ({ page }) => {
    await deployment(page, CODE_ONLY);

    await page.goto('/login');

    await expect(page.getByRole('button', { name: 'Email me a code' })).toBeVisible();
    await expect(page.getByRole('button', { name: /first-sign-in token/ })).toBeHidden();
  });

  test('creates an account from the sign-up screen and lands on the console', async ({ page, baseURL }) => {
    await deployment(page, CODE_ONLY);
    const { requested, submitted } = await mockEmailCode(page, { session: 'e2e-signup-session' });

    await page.goto('/login');
    await page.getByRole('link', { name: 'Create one' }).click();
    // `from=login` rides along so `signup_started` can tell this visitor from one
    // who opened the sign-up page directly (SUP-145).
    await expect(page).toHaveURL(/\/signup\?from=login$/);
    await expect(page.getByLabel(/password/i)).toHaveCount(0);

    await page.getByLabel('Name (optional)').fill('New Comer');
    await page.getByLabel('Email').fill('newcomer@example.com');
    await page.getByRole('button', { name: 'Email me a code' }).click();

    // The address is proven by the mail before anything is created.
    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
    expect(requested).toEqual([{ email: 'newcomer@example.com', type: 'sign-in' }]);
    expect(submitted).toEqual([]);
    await capture(page, 'signup-code');

    await page.getByLabel('Code', { exact: true }).fill(MAILED_CODE);
    await page.getByRole('button', { name: 'Create account' }).click();

    // The same request that signs an account in creates this one, so the name
    // rides it.
    expect(submitted).toEqual([{ email: 'newcomer@example.com', otp: MAILED_CODE, name: 'New Comer' }]);
    await expect(page).toHaveURL(`${baseURL}/`);
  });

  test('says so on a deployment that cannot mail a code', async ({ page }) => {
    await deployment(page, MAILER_LESS);

    await page.goto('/signup');

    await expect(page.getByText('Registration by email is not available on this deployment')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeHidden();
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
  /** What a sign-in by code gets: an answer, and a cookie on the API's host. */
  async function apiSignsIn(page: Page): Promise<void> {
    await mockEmailCode(page, { session: 'e2e-cross-host-session' });
  }

  test('leaves the session cookie on the API host and the routing marker on the console\u2019s', async ({ page }) => {
    await deployment(page, CODE_ONLY);
    await apiSignsIn(page);

    await page.goto('/login');
    await signInByCode(page);
    await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/`);

    const named = async (origin: string) => (await page.context().cookies(origin)).map((cookie) => cookie.name);
    // The console cannot read the API's cookie \u2014 not on a deployment, and no
    // longer here either. Its own marker is what got the browser through.
    expect(await named(API_ORIGIN)).toContain(SESSION_COOKIE_NAME);
    expect(await named(CONSOLE_ORIGIN)).not.toContain(SESSION_COOKIE_NAME);
    expect(await named(CONSOLE_ORIGIN)).toContain(SIGNED_IN_COOKIE_NAME);
  });

  test('stays signed in across a reload', async ({ page }) => {
    await deployment(page, CODE_ONLY, CONSOLE_OPERATIONS);
    await apiSignsIn(page);

    await page.goto('/login');
    await signInByCode(page);
    await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/`);

    await page.reload();

    await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  });

  test('comes back to the deep link that sent the viewer to the sign-in screen', async ({ page }) => {
    await deployment(page, CODE_ONLY, CONSOLE_OPERATIONS);
    await apiSignsIn(page);

    await page.goto('/models');
    await expect(page).toHaveURL(/\/login\?next=%2Fmodels$/);

    await signInByCode(page);

    await expect(page).toHaveURL(`${CONSOLE_ORIGIN}/models`);
    await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  });

  test('lets a session that arrived by redirect in, instead of looping', async ({ page }) => {
    // A magic link and an OAuth callback both come back from router-api without
    // running any console code, so nothing raised the marker: the proxy sends
    // the browser to `/login` with a live session it cannot see. The sign-in
    // screen asks the API, and that is what breaks the loop.
    await deployment(page, CODE_ONLY, { ...CONSOLE_OPERATIONS, SignedIn: { me: { id: SESSION_DATA.me.id } } });
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
