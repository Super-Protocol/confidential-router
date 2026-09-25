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
import { API_ORIGIN } from './origins';

const CODE = 'ABCD-EFGH-JKLM';
const NORMALISED = 'ABCDEFGHJKLM';
const CAMPAIGN = 'launch-2026-10-devs';
const GRANT_MICROS = '100000000';
const WORKSPACE_ID = SESSION_DATA.me.workspaces[0].id;

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
  /** Every body posted to `/auth/sign-up/email`. */
  signUps: Array<Record<string, unknown>>;
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
    NextStep: { apiKeys: [] },
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
 * refused until `/auth/sign-up/email` has been answered, and only then does the
 * API's cookie appear. That is the real sequence, and it is the one thing a
 * component test cannot exercise.
 */
async function mockInviteFlow(page: Page, operations: GraphQLFixtures): Promise<Recorded> {
  const recorded: Recorded = { events: [], signUps: [] };
  let created = false;

  await page.route('**/v1/analytics/events', async (route) => {
    recorded.events.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 202, body: '' });
  });

  await page.route('**/auth/sign-up/email', async (route) => {
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

async function fillInAndSubmit(page: Page): Promise<void> {
  await page.getByLabel('Email').fill('invited@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
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
    expect(signUps[0]).toMatchObject({ email: 'invited@example.com', inviteCode: NORMALISED });
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
    // The snippet is already written out, not a link to documentation about one.
    await expect(nudge).toContainText('from openai import OpenAI');
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
