/**
 * The invitation flow in a real browser: the mailed URL, the promise on the form,
 * the account, and the credit on the other side of it.
 *
 * Mocked at the HTTP boundary rather than at the component, because almost
 * everything that can go wrong here is a boundary: the code has to survive a
 * cross-origin navigation, ride a request body the console does not own, and come
 * back as an answer to a *different* query on a *different* screen. A component
 * test cannot see any of that. `cross-app.spec.ts` covers the same screens against
 * a live API; this one covers the paths a live API cannot be steered into on
 * demand — an expired code, a spent one.
 */
import { expect, type Page, test } from '@playwright/test';
import { type GraphQLFixtures, mockGraphQL, SESSION_DATA, signIn, UNAUTHENTICATED } from './fixtures';
import { API_HOST, API_ORIGIN, CONSOLE_HOST, CONSOLE_ORIGIN } from './origins';

const CODE = 'ABCD-EFGH-JKLM';
const NORMALISED = 'ABCDEFGHJKLM';
const CAMPAIGN = 'launch-2026-10-devs';
const GRANT_MICROS = '100000000';
/** What the onboarding card's snippet has to name — a model the catalogue serves. */
const SAMPLE_MODEL = 'google/gemma-2-2b-it:tee';
const WORKSPACE_ID = SESSION_DATA.me.workspaces[0].id;

/**
 * The router's two email-code routes (SUP-269). The first mails a code to any
 * address; the second trades it for a session and, for an address with no
 * account, creates the account — so it is the sign-up, and the invitation rides
 * its body.
 */
const SEND_CODE_ROUTE = '**/auth/email-otp/send-verification-otp';
const SIGN_UP_ROUTE = '**/auth/sign-in/email-otp';
/** The code every mocked mail "carries". */
const MAILED_CODE = '482913';

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

/** The invitation URL a mailing sends, as it arrives at the console. */
function signUpUrl(code = CODE): string {
  return `/signup?invite=${encodeURIComponent(code)}&utm_source=email&utm_medium=email&utm_campaign=${CAMPAIGN}`;
}

/** What `GET /v1/invites/:code` answers. Every unusable code is one `unavailable`. */
async function mockLookup(page: Page, answer: Record<string, unknown>): Promise<void> {
  await page.route('**/v1/invites/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) }),
  );
}

interface Recorded {
  /** Every body posted to the first-party analytics ingest, in order. */
  events: Array<Record<string, unknown>>;
  /** Every body posted to `/auth/sign-in/email-otp` — the request that creates the account. */
  signUps: Array<Record<string, unknown>>;
  /** Every body posted to `/auth/email-otp/send-verification-otp`: one per mailed code. */
  codeRequests: Array<Record<string, unknown>>;
}

function creditsFixtures(grantMicros: string, extra: GraphQLFixtures = {}): GraphQLFixtures {
  return {
    Credits: {
      creditBalance: {
        __typename: 'CreditBalance',
        workspaceId: WORKSPACE_ID,
        balanceMicros: grantMicros,
        spendable: BigInt(grantMicros) > 0n,
        minTopUpMicros: '5000000',
        maxTopUpMicros: '10000000000',
        purchasesAvailable: true,
        autoTopUp: {
          __typename: 'AutoTopUp',
          enabled: false,
          available: true,
          thresholdMicros: null,
          amountMicros: null,
          lastChargedAt: null,
        },
      },
      creditTransactions: {
        __typename: 'CreditTransactionConnection',
        totalCount: grantMicros === '0' ? 0 : 1,
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
        edges:
          grantMicros === '0'
            ? []
            : [
                {
                  __typename: 'CreditTransactionEdge',
                  cursor: 'txn-1',
                  node: {
                    __typename: 'CreditTransaction',
                    id: 'txn-1',
                    createdAt: '2026-09-25T12:00:00.000Z',
                    kind: 'GRANT',
                    amountMicros: grantMicros,
                    reference: CAMPAIGN,
                    description: `Invitation credit · ${CAMPAIGN}`,
                  },
                },
              ],
      },
    },
    // The card's snippet names the catalogue's first model, so the fixture has to
    // carry one (SUP-153).
    // `available` is not decoration: the card names the first *routable* model,
    // because an external model whose upstream holds no admitting verdict is
    // listed and answers 503 (ADR-008 decision 5, SUP-227). A stub that omits it
    // renders a card with no snippet at all.
    NextStep: { apiKeys: [], models: [{ __typename: 'Model', id: SAMPLE_MODEL, available: true }] },
    ...extra,
  };
}

function grantStatus(grant: boolean, reason: string | null): GraphQLFixtures {
  return {
    InviteGrantStatus: {
      inviteGrantStatus: {
        __typename: 'InviteGrantStatus',
        reason,
        grant: grant
          ? {
              __typename: 'InviteGrant',
              creditTransactionId: 'txn-1',
              grantMicros: GRANT_MICROS,
              campaign: CAMPAIGN,
              redeemedAt: '2026-09-25T12:00:00.000Z',
            }
          : null,
      },
    },
  };
}

/**
 * A browser arriving at `/signup` with no account, and everything the flow needs
 * on the way out.
 *
 * `signIn` cannot be used for a test that starts on the sign-up screen: it plants
 * the console's marker cookie, and `proxy.ts` sends a browser holding that one
 * straight to the console. Nor can `SignedIn` simply answer with a session —
 * `<ResumeSession />` probes it on every auth page and would bounce the visitor off
 * the form before they saw it.
 *
 * So the session comes into existence when the sign-up says it did: `SignedIn` is
 * refused until `/auth/sign-in/email-otp` has been answered, and only then does the
 * API's cookie appear. That is the real sequence, and it is the one thing a
 * component test cannot exercise.
 */
async function mockInviteFlow(page: Page, operations: GraphQLFixtures): Promise<Recorded> {
  const recorded: Recorded = { events: [], signUps: [], codeRequests: [] };
  let created = false;

  await page.route('**/v1/analytics/events', async (route) => {
    recorded.events.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 202, body: '' });
  });

  await page.route(SEND_CODE_ROUTE, async (route) => {
    recorded.codeRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });

  await page.route(SIGN_UP_ROUTE, async (route) => {
    recorded.signUps.push(route.request().postDataJSON() as Record<string, unknown>);
    created = true;
    await page.context().addCookies([{ name: 'cr_session', value: 'e2e-session-token', url: API_ORIGIN }]);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: SESSION_DATA.me.id } }),
    });
  });

  await mockGraphQL(page, {
    SignedIn: () => (created ? { me: { id: SESSION_DATA.me.id } } : UNAUTHENTICATED),
    ...operations,
  });

  return recorded;
}

/**
 * Both steps of the form: an address and a mailed code asked for, then the code handed back.
 *
 * The code field is matched exactly. The first step can carry a field labelled
 * "Invitation code", and a loose `Code` matches that one for as long as the
 * request for a mailed code is still out — so the mailed code was typed into the
 * invitation, and the step that then appeared had an empty field and a disabled
 * button. It only lost the race on a slow, single-worker run, which is CI.
 */
async function fillInAndSubmit(page: Page): Promise<void> {
  await page.getByLabel('Email').fill('invited@example.com');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel('Code', { exact: true }).fill(MAILED_CODE);
  await page.getByRole('button', { name: 'Create account' }).click();
}

test.describe('signing up from an invitation URL', () => {
  test('promises the credit, applies it, and opens the Credits screen with it already there', async ({ page }) => {
    await mockLookup(page, { valid: true, grantMicros: GRANT_MICROS, campaign: CAMPAIGN });
    const { events, signUps } = await mockInviteFlow(page, {
      SignInOptions: SIGN_IN_OPTIONS,
      ...creditsFixtures(GRANT_MICROS),
      ...grantStatus(true, null),
    });

    await page.goto(signUpUrl());

    // The visitor never types the code: it arrived in the URL.
    await expect(page.getByTestId('invite-grant-pending')).toContainText(
      '$100 in credits will be added to your account.',
    );
    await expect(page.getByLabel('Invitation code')).toBeHidden();

    await fillInAndSubmit(page);

    await expect(page).toHaveURL(/\/credits/);
    await expect(page.getByTestId('invite-granted')).toContainText('$100 in credits is in your account.');
    // The balance is there on the first page load, and the ledger names the
    // campaign that paid for it.
    await expect(page.getByTestId('credit-balance')).toContainText('$100.00');
    await expect(page.getByRole('row', { name: /Invitation credit/ })).toContainText(CAMPAIGN);

    // The code went out with the sign-up, normalised the way the API stores it.
    expect(signUps[0]).toMatchObject({ email: 'invited@example.com', otp: MAILED_CODE, inviteCode: NORMALISED });
    expect(events[0]).toMatchObject({
      event: 'signup_started',
      properties: { has_invite: true, campaign: CAMPAIGN, utm_campaign: CAMPAIGN, entry: 'landing_cta' },
    });
  });

  test('points an account with credit and no key at the one step left', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string, creditsFixtures(GRANT_MICROS));

    await page.goto('/credits');

    const nudge = page.getByTestId('next-step-card');
    // `SESSION_DATA`'s workspace balance, whatever it is — the card quotes what
    // the session says, and a second copy of the number here would just drift.
    const dollars = `$${(Number(SESSION_DATA.me.workspaces[0].balanceMicros) / 1_000_000).toFixed(2)}`;
    await expect(nudge).toContainText(`You have ${dollars} to spend. One step to go.`);
    // The snippet is already written out, not a link to documentation about one,
    // and it names a model the deployment serves — the SUP-153 defect was a card
    // offering `meta/llama-3.3-70b-instruct:tdx`, which answers 404.
    await expect(nudge).toContainText('from openai import OpenAI');
    await expect(nudge).toContainText(SAMPLE_MODEL);
    await expect(nudge.getByRole('link', { name: /Create a key/ })).toHaveAttribute('href', '/keys');
  });

  test('says a spent code cannot be used, and still creates the account', async ({ page }) => {
    // The second browser on the same invitation URL: the code is the only thing
    // it carries, and the code is gone.
    await mockLookup(page, { valid: false, reason: 'unavailable' });
    const { signUps } = await mockInviteFlow(page, {
      SignInOptions: SIGN_IN_OPTIONS,
      ...creditsFixtures('0'),
      ...grantStatus(false, 'EXHAUSTED'),
    });

    await page.goto(signUpUrl());

    await expect(page.getByTestId('invite-unavailable')).toContainText('still create an account');

    await fillInAndSubmit(page);

    await expect(page).toHaveURL(/\/credits/);
    // One reason, in its own words, and the account is explicitly fine.
    await expect(page.getByTestId('invite-refused')).toContainText('already been claimed');
    await expect(page.getByTestId('invite-refused')).toContainText('Your account is ready');
    await expect(page.getByTestId('credit-balance')).toContainText('$0.00');
    // Sent anyway: only the redemption inside account creation decides.
    expect(signUps[0]).toMatchObject({ inviteCode: NORMALISED });
  });

  test('lets someone who lost the link paste the code instead', async ({ page }) => {
    await mockLookup(page, { valid: true, grantMicros: GRANT_MICROS, campaign: CAMPAIGN });
    await mockInviteFlow(page, { SignInOptions: SIGN_IN_OPTIONS });

    await page.goto('/signup');

    await page.getByRole('button', { name: 'Have a code?' }).click();
    await page.getByLabel('Invitation code').fill('abcd efgh jklm');
    await page.getByRole('button', { name: 'Apply' }).click();

    await expect(page.getByTestId('invite-grant-pending')).toContainText('$100 in credits');
  });
});

/**
 * The OAuth hop, in a browser, across two hosts.
 *
 * The one path where the invitation code cannot ride the request: the provider
 * builds the callback URL, so nothing of ours survives it except a cookie. And a
 * cookie is exactly what is easy to get wrong here — written with no `Domain` it
 * is host-only, so it goes back to `console.…` and never to `api.…`, and the
 * $100 is lost with no error anywhere.
 *
 * This suite is the only place that can catch that, because it is the only place
 * with two hosts: `console.localtest.me` and `api.localtest.me` share a
 * registrable domain exactly as a deployment's hosts do (`origins.ts`). A unit
 * test can assert the attribute; only a browser can prove the cookie crosses.
 */
test.describe('an invitation carried through OAuth', () => {
  test('sends the code to the API host the provider redirects to', async ({ page }) => {
    // Chromium maps both names to loopback, but keys cookies by host — so this is
    // a genuine cross-host hop, not a same-origin one.
    expect(CONSOLE_HOST).not.toBe(API_HOST);

    const callback = `${API_ORIGIN}/auth/callback/github?code=provider-stub&state=stub`;
    let callbackCookies: string | undefined;

    await page.route('**/auth/sign-in/social', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: callback }) }),
    );
    await page.route('**/auth/callback/github**', async (route) => {
      // `allHeaders()` and not `headers()`: the synchronous form omits the
      // browser-managed `Cookie` header, which is the only one this test is about.
      callbackCookies = (await route.request().allHeaders()).cookie;
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>callback</body></html>' });
    });
    await mockGraphQL(page, {
      SignInOptions: {
        signInOptions: { ...SIGN_IN_OPTIONS.signInOptions, github: true },
      },
    });

    await page.goto(`/login?invite=${encodeURIComponent(CODE)}`);
    await page.getByRole('button', { name: 'Continue with GitHub' }).click();
    await page.waitForURL(/\/auth\/callback\/github/);

    // The assertion the whole `Domain` attribute exists for: the request the
    // provider sent the browser to, on the *API* host, carried the code.
    expect(callbackCookies, 'the callback request carried no cookies at all').toBeDefined();
    expect(callbackCookies).toContain(`cr_invite=${NORMALISED}`);

    // And the cookie really is scoped to the shared suffix, not to the console.
    const stored = await page.context().cookies();
    const invite = stored.find((cookie) => cookie.name === 'cr_invite');
    expect(invite?.domain).toBe(`.${API_HOST.split('.').slice(1).join('.')}`);
  });
});

/**
 * Invite-only registration, in a real browser (SUP-173).
 *
 * The router is the enforcement and it is tested where it lives; what a browser
 * adds here is the thing that went wrong in the first place — a refusal the
 * visitor did not notice. So every case asserts on what is on the screen and
 * whether the button can be pressed, and one of them asserts the refusal survives
 * a redirect from another origin, which no component test can reach.
 */
test.describe('a deployment where registration is by invitation', () => {
  const INVITE_ONLY = {
    signInOptions: { ...SIGN_IN_OPTIONS.signInOptions, inviteRequired: true },
  };

  test('says so, opens the code field, and mails nothing until an invitation works', async ({ page }) => {
    await mockLookup(page, { valid: false, reason: 'unavailable' });
    const { signUps, codeRequests } = await mockInviteFlow(page, { SignInOptions: INVITE_ONLY });

    await page.goto('/signup');

    await expect(page.getByTestId('invite-required-notice')).toContainText('Registration is by invitation');
    await expect(page.getByLabel('Invitation code')).toBeVisible();

    await page.getByLabel('Email').fill('invited@example.com');
    // Held before the mail, not after it: a mailed code is spent by being
    // checked, so a refusal on the far side of it would cost the visitor a trip
    // to their inbox for nothing.
    await expect(page.getByRole('button', { name: 'Email me a code' })).toBeDisabled();
    await expect(page.getByTestId('sign-up-blocked-on-invite')).toContainText('working invitation code');
    expect(codeRequests).toHaveLength(0);
    expect(signUps).toHaveLength(0);
  });

  test('makes a code that cannot be used an alert, not a line about credit', async ({ page }) => {
    await mockLookup(page, { valid: false, reason: 'unavailable' });
    await mockInviteFlow(page, { SignInOptions: INVITE_ONLY });

    await page.goto(signUpUrl());

    const alert = page.getByTestId('invite-unavailable-required');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('cannot be used');
    // The open-sign-up copy invited the visitor to carry on without the credit.
    // Here there is nothing to carry on to.
    await expect(page.getByTestId('invite-unavailable')).toBeHidden();
    // And it does not guess which refusal it is — the lookup cannot know (SUP-176).
    await expect(alert).not.toContainText('may already have been claimed');
  });

  /**
   * A spent code and a code nobody ever issued, side by side, in a browser
   * (SUP-176).
   *
   * The lookup answers the same `unavailable` to both by design, so the only
   * place the two come apart is the sign-up's typed 403 — and the console used to
   * hold the button that would fetch it, which made the two indistinguishable to
   * everyone who was not using `curl`. Both halves run the same script; the only
   * difference is what the router answers.
   */
  for (const [code, sentence] of [
    ['invite_already_claimed', 'already been claimed'],
    ['invite_expired_or_unknown', 'may have expired'],
  ] as const) {
    test(`submits a code the lookup refused and shows the router's own refusal: ${code}`, async ({ page }) => {
      await mockLookup(page, { valid: false, reason: 'unavailable' });
      await mockInviteFlow(page, { SignInOptions: INVITE_ONLY });
      // Registered after `mockInviteFlow`, so it wins: the router refuses instead
      // of creating the account, and this handler is what records the attempt.
      const attempts: Array<Record<string, unknown>> = [];
      await page.route(SIGN_UP_ROUTE, (route) => {
        attempts.push(route.request().postDataJSON() as Record<string, unknown>);
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ code, message: 'refused' }),
        });
      });

      await page.goto(signUpUrl());
      await expect(page.getByTestId('invite-unavailable-required')).toBeVisible();
      await fillInAndSubmit(page);

      await expect(page.getByTestId(`invite-refused-${code}`)).toContainText(sentence);
      // The snapshot it replaces is gone, so there is one sentence on screen.
      await expect(page.getByTestId('invite-unavailable-required')).toBeHidden();
      // The refusal the visitor read is the one answered to their own code.
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ inviteCode: NORMALISED });
      // Refused before the insert, so the visitor is still on the form — and back
      // on its first step, where the invitation is: the mailed code went with
      // the refusal.
      await expect(page).toHaveURL(/\/signup/);
      await expect(page.getByLabel('Invitation code')).toBeVisible();
      await expect(page.getByLabel('Code', { exact: true })).toBeHidden();
    });
  }

  test('lets a good code through, unchanged', async ({ page }) => {
    await mockLookup(page, { valid: true, grantMicros: GRANT_MICROS, campaign: CAMPAIGN });
    const { signUps } = await mockInviteFlow(page, {
      SignInOptions: INVITE_ONLY,
      ...creditsFixtures(GRANT_MICROS),
      ...grantStatus(true, null),
    });

    await page.goto(signUpUrl());
    await expect(page.getByTestId('invite-grant-pending')).toContainText('$100 in credits');
    await fillInAndSubmit(page);

    await expect(page).toHaveURL(/\/credits/);
    expect(signUps[0]).toMatchObject({ inviteCode: NORMALISED });
  });

  test('shows the refusal the router answered the sign-up with, rather than a generic error', async ({ page }) => {
    await mockLookup(page, { valid: true, grantMicros: GRANT_MICROS, campaign: CAMPAIGN });
    await mockInviteFlow(page, { SignInOptions: INVITE_ONLY });
    // The last seat went between the lookup and the submit — the one window the
    // pre-check cannot close.
    await page.route(SIGN_UP_ROUTE, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'invite_already_claimed', message: 'This invitation has already been claimed.' }),
      }),
    );

    await page.goto(signUpUrl());
    await expect(page.getByTestId('invite-grant-pending')).toBeVisible();
    await fillInAndSubmit(page);

    await expect(page.getByTestId('invite-refused-invite_already_claimed')).toContainText('already been claimed');
    await expect(page).toHaveURL(/\/signup/);
  });

  /**
   * The OAuth refusal, which is the only one that crosses an origin: the router
   * redirects the browser back to the console with `?error=` on it, and the
   * console has to read that as an invitation problem and offer the way out.
   */
  test('carries an OAuth refusal back to the screen the visitor started on', async ({ page }) => {
    await mockInviteFlow(page, {
      SignInOptions: { signInOptions: { ...INVITE_ONLY.signInOptions, github: true } },
    });

    let errorCallback: string | undefined;
    await page.route('**/auth/sign-in/social', async (route) => {
      errorCallback = (route.request().postDataJSON() as { errorCallbackURL?: string }).errorCallbackURL;
      // What the router does when the callback's user creation is refused.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: `${errorCallback}?error=invite_required` }),
      });
    });

    await page.goto('/login');
    await page.getByRole('button', { name: 'Continue with GitHub' }).click();

    // Absolute and on the console's own origin: the router resolves a relative
    // one against its own.
    expect(errorCallback).toBe(`${CONSOLE_ORIGIN}/login`);
    await expect(page.getByTestId('invite-refused-invite_required')).toContainText('You need an invitation');
    await expect(page.getByRole('link', { name: 'Enter a code' })).toBeVisible();
  });
});
