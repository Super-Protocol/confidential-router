/**
 * The console against the real router-api.
 *
 * These are the flows that cross an app boundary, so they are the ones no
 * amount of GraphQL mocking can keep honest: the screens here read whatever the
 * running API answers, and the last test takes a key minted in the browser and
 * spends it against `/v1`.
 *
 * Run by the `cross-app` Playwright project only — see `playwright.config.ts`.
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { SESSION_COOKIE_NAME, SIGNED_IN_COOKIE_NAME } from './fixtures';
import { readHandoff, readMailedCode, type StackHandoff, useAdminSession, useSession } from './stack';

let handoff: StackHandoff;

test.beforeAll(async () => {
  handoff = await readHandoff();
});

test.beforeEach(async ({ page, baseURL }) => {
  await useSession(page, baseURL as string, handoff);
});

test.describe('the console, against a live router-api', () => {
  test('renders the signed-in shell with the workspace the API provisioned', async ({ page }) => {
    await page.goto('/');

    // Not redirected to the login screen: the session cookie travelled and the
    // API answered the session query.
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: `Account: ${handoff.email}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Workspace: ${handoff.email}` })).toBeVisible();
  });

  test('lists the catalogue the router is configured with', async ({ page }) => {
    await page.goto('/models');

    await expect(page.getByRole('table', { name: 'Model catalogue' })).toBeVisible();
    await expect(page.getByText('Llama 3.3 70B Instruct').first()).toBeVisible();
  });

  test('shows the evidence the endpoint actually published', async ({ page }) => {
    await page.goto('/');

    const endpoints = page.getByRole('table', { name: 'Confidential endpoints' });
    await expect(endpoints.getByRole('row', { name: new RegExp(handoff.endpointHostname) })).toBeVisible();
  });

  test('shows the credits the checkout actually recorded', async ({ page }) => {
    await page.goto('/credits');

    const dollars = `$${(handoff.balanceMicros / 1_000_000).toFixed(2)}`;
    await expect(page.getByText(dollars, { exact: false }).first()).toBeVisible();
  });

  test('lists the key the stack minted through the same API', async ({ page }) => {
    await page.goto('/keys');

    await expect(page.getByRole('row', { name: /Demo key/ })).toBeVisible();
  });

  test('mints a key in the browser that the gateway then accepts', async ({ page, request }) => {
    await page.goto('/keys');
    await page.getByRole('button', { name: 'New key' }).click();
    await page.getByLabel('Name').fill('minted-in-the-browser');
    await page.getByRole('button', { name: 'Create key' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Copy your key now')).toBeVisible();
    // The block carries its own copy button, so its text is the key plus a
    // label; the key is what matches the minting format.
    const shown = await dialog.getByTestId('created-key-secret').innerText();
    const secret = /sk-tee-v1-[A-Za-z0-9_-]{43}/.exec(shown)?.[0];
    expect(secret, `no key in the dialog text: ${shown}`).toBeDefined();

    // The whole point of the flow: a credential the console just showed is one
    // the gateway will honour.
    const completion = await request.post(`${handoff.apiBaseUrl}/v1/chat/completions`, {
      headers: { authorization: `Bearer ${secret as string}`, 'content-type': 'application/json' },
      data: {
        model: 'meta/llama-3.3-70b-instruct:tdx',
        messages: [{ role: 'user', content: 'Minted in the browser' }],
      },
    });

    expect(completion.status()).toBe(200);
    const body = (await completion.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toContain('Minted in the browser');
  });

  test('shows the generations those keys produced, under Activity and Logs', async ({ page }) => {
    await page.goto('/activity');
    await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();

    // Activity aggregates; the per-generation rows are on Logs, which is where
    // a call made a moment ago has to show up by name.
    await page.goto('/logs');
    await expect(page.getByRole('heading', { level: 1, name: 'Logs' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Llama 3.3 70B Instruct' }).first()).toBeVisible();
  });
});

/**
 * Signing in, against the real API (SUP-269) — the acceptance criterion of the
 * issue, and the one flow here that starts with no session at all.
 *
 * There is no password anywhere: an address is mailed a one-time code, and
 * handing it back opens a session, creating the account if the address had
 * none. The stack's mailer writes the mail to the router's log, which
 * `readMailedCode` reads the way a person reads their inbox.
 *
 * Serial, because it is one story told in three steps and each needs what the
 * step before left behind: the code that was used, and the browser state it
 * bought. Every browser here is its own context — the `page` fixture carries
 * the handoff's session (`beforeEach` above), which is exactly what these must
 * not start with.
 */
test.describe
  .serial('signing in by emailed code, against a live router-api', () => {
    const email = `code-e2e-${Date.now().toString(36)}@example.com`;
    /** The code the first case signed in with — spent from then on. */
    let usedCode: string;
    /** What that browser held once it was signed in: its cookies, on both hosts. */
    let signedInState: Awaited<ReturnType<BrowserContext['storageState']>>;

    const DAY_SECONDS = 86_400;

    /** `/login`, an address, and "Email me a code" — ending on the code step. */
    async function askForCode(page: Page): Promise<void> {
      await page.goto('/login');
      await page.getByLabel('Email').fill(email);
      await page.getByRole('button', { name: 'Email me a code' }).click();
      await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
    }

    test('signs a fresh browser in with the code mailed to its address', async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      expect(await context.cookies()).toEqual([]);

      // No session, so the console sends the browser to the sign-in screen.
      await page.goto('/');
      await expect(page).toHaveURL(/\/login$/);

      await askForCode(page);
      await expect(page.getByText(`We sent a 6-digit code to ${email}.`, { exact: false })).toBeVisible();

      usedCode = await readMailedCode(handoff, email);
      await page.getByLabel('Code', { exact: true }).fill(usedCode);
      await page.getByRole('button', { name: 'Sign in' }).click();

      // The address had no account: the same request created it, with the
      // personal workspace every account gets, and the shell renders for it.
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.getByRole('navigation', { name: 'Console' })).toBeVisible();
      await expect(page.getByRole('button', { name: `Account: ${email}` })).toBeVisible();
      await expect(page.getByRole('button', { name: `Workspace: ${email}` })).toBeVisible();

      signedInState = await context.storageState();
      await context.close();
    });

    test('keeps that browser signed in across a restart, for about ninety days', async ({ browser, baseURL }) => {
      // A session cookie with no expiry dies with the browser, and a restart is
      // what `storageState` into a new context is: nothing survives it that was
      // not written to disk.
      const session = signedInState.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
      expect(session, 'the API left no session cookie').toBeDefined();
      expect(new URL(handoff.apiOrigin).hostname).toContain((session?.domain ?? '').replace(/^\./, ''));
      // `auth.sessionMaxAge` is 90 days. Bounded on both sides: persistent, and
      // not for ever either.
      const lifetime = (session?.expires ?? -1) - Date.now() / 1000;
      expect(lifetime).toBeGreaterThan(80 * DAY_SECONDS);
      expect(lifetime).toBeLessThan(100 * DAY_SECONDS);

      const context = await browser.newContext({ baseURL, storageState: signedInState });
      const page = await context.newPage();

      await page.goto('/');

      // No bounce to the sign-in screen, and it is the same account.
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.getByRole('button', { name: `Account: ${email}` })).toBeVisible();
      await context.close();
    });

    test('refuses the same code a second time', async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      // The code step is only reachable by asking for a code, and a real request
      // would mail a new one — which replaces the old, so the refusal below would
      // prove nothing about reuse. The request is answered here instead; the
      // attempt that follows goes to the real router.
      await page.route('**/auth/email-otp/send-verification-otp', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }),
      );

      await askForCode(page);
      await page.getByLabel('Code', { exact: true }).fill(usedCode);
      await page.getByRole('button', { name: 'Sign in' }).click();

      // The router forgets a code the moment it is used, so a second attempt is
      // answered as a wrong code (`INVALID_OTP`) rather than as an expired one —
      // which is also why that sentence offers a new code and not only a retry.
      await expect(page.locator('#email-code-error')).toContainText(
        'That code is not right. Check the mail and try again, or send a new one.',
      );
      await expect(page).toHaveURL(/\/login$/);
      const named = (await context.cookies()).map((cookie) => cookie.name);
      expect(named).not.toContain(SESSION_COOKIE_NAME);
      expect(named).not.toContain(SIGNED_IN_COOKIE_NAME);

      // And the console is still closed to it.
      await page.goto('/keys');
      await expect(page).toHaveURL(/\/login\?next=%2Fkeys$/);
      await context.close();
    });
  });

/**
 * The Invitations section against the real API (SUP-268): an operator issues a
 * code in the browser, somebody signs up with it, and the redemption is then
 * visible from both sides — the code's row and the account's — and in the
 * statistics. Driven as the stack's operator, who is a different person from
 * the member every other case here signs in as.
 */
test.describe('the Invitations section, against a live router-api', () => {
  test('issues a code, and finds its redemption in the codes, the sign-ups and the statistics', async ({
    page,
    baseURL,
    request,
  }) => {
    await useAdminSession(page, baseURL as string, handoff);
    const campaign = `e2e-${Date.now().toString(36)}`;
    const email = `${campaign}@example.com`;

    await page.goto('/admin/invitations');
    await page.getByRole('button', { name: 'Issue codes' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Credit per code (USD)').fill('25');
    await dialog.getByLabel('Campaign tag').fill(campaign);
    await dialog.getByRole('button', { name: 'Issue codes' }).click();
    await expect(dialog.getByText('Invitation code issued')).toBeVisible();
    const code = (await dialog.getByTestId('issued-code').innerText()).trim();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await dialog.getByRole('button', { name: 'Done' }).click();

    // Somebody redeems it, the way the console's own sign-up form does: a code
    // is mailed to the address, and handing it back is what creates the account
    // — with the invitation on the same request (SUP-269).
    const mailed = await request.post(`${handoff.apiBaseUrl}/auth/email-otp/send-verification-otp`, {
      headers: { origin: handoff.consoleOrigin },
      data: { email, type: 'sign-in' },
    });
    expect(mailed.status(), await mailed.text()).toBe(200);
    const created = await request.post(`${handoff.apiBaseUrl}/auth/sign-in/email-otp`, {
      headers: { origin: handoff.consoleOrigin },
      data: { email, otp: await readMailedCode(handoff, email), name: 'Invited', inviteCode: code },
    });
    expect(created.status(), await created.text()).toBe(200);

    await page.getByRole('tab', { name: 'Codes' }).click();
    const codeRow = page
      .getByRole('table', { name: 'Invitation codes' })
      .getByRole('row')
      .filter({ hasText: campaign });
    await expect(codeRow).toContainText('Redeemed');
    await expect(codeRow).toContainText(email);
    await expect(codeRow).toContainText(handoff.adminEmail);
    // Masked until asked.
    await expect(codeRow).not.toContainText(code);
    await codeRow.getByRole('button', { name: /^Reveal code/ }).click();
    await expect(codeRow).toContainText(code);

    await page.getByRole('tab', { name: 'Sign-ups' }).click();
    const accountRow = page.getByRole('table', { name: 'Sign-ups' }).getByRole('row').filter({ hasText: email });
    await expect(accountRow).toContainText('Invitation');
    await expect(accountRow).toContainText(campaign);

    await page.getByRole('tab', { name: 'Statistics' }).click();
    const campaignRow = page.getByRole('table', { name: 'Campaigns' }).getByRole('row').filter({ hasText: campaign });
    await expect(campaignRow).toContainText('100%');
    await expect(campaignRow).toContainText('$25');
    await expect(page.getByRole('img', { name: /Sign-ups per day by origin/ })).toBeVisible();
  });

  test('shows a member nothing of it', async ({ page }) => {
    await page.goto('/admin/invitations');

    await expect(page.getByTestId('invitations-restricted')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Issue codes' })).toHaveCount(0);
  });
});

/**
 * Export & import against the real API (SUP-271): the operator downloads this
 * deployment's export in the browser and gives the same file back to it. Every
 * row is already here, so the check has to read as a clean retry — nothing to
 * create, nothing colliding — and importing it has to change nothing. The move
 * between two deployments is `data-migration.e2e.spec.ts` in router-api, which
 * can stand up two; this is the browser, the cookie and the upload for real.
 */
test.describe('the Export & import section, against a live router-api', () => {
  test('downloads the export, and re-imports it as a no-op', async ({ page, baseURL }) => {
    await useAdminSession(page, baseURL as string, handoff);
    await page.goto('/admin/migration');

    const pending = page.waitForEvent('download');
    await page.getByTestId('export-button').click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(/^router-export-\d{8}-\d{4}-.+\.json\.gz$/);
    const sha = (await page.getByTestId('export-sha').innerText()).trim();
    expect(sha).toMatch(/^[0-9a-f]{64}$/);

    await page.getByTestId('import-file').setInputFiles(await download.path());
    await page.getByTestId('import-check').click();

    await expect(page.getByTestId('import-verdict')).toHaveText('Ready to import — nothing written yet');
    await expect(page.getByTestId('import-sha')).toHaveText(sha);
    const accounts = page.getByTestId('import-section-users').getByRole('cell');
    const inFile = Number(await accounts.nth(1).innerText());
    expect(inFile).toBeGreaterThanOrEqual(2);
    await expect(accounts.nth(2)).toHaveText('0');
    await expect(accounts.nth(3)).toHaveText(String(inFile));
    await expect(accounts.nth(4)).toHaveText('0');

    await page.getByTestId('import-apply').click();
    await expect(page.getByTestId('import-verdict')).toContainText('Imported');
    await expect(page.getByTestId('import-section-creditLedger').getByRole('cell').nth(2)).toHaveText('0');
  });

  test('shows a member nothing of it', async ({ page }) => {
    await page.goto('/admin/migration');

    await expect(page.getByTestId('data-migration-restricted')).toBeVisible();
    await expect(page.getByTestId('export-button')).toHaveCount(0);
  });
});
