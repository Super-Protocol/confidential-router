import type { Page } from '@playwright/test';
import { API_ORIGIN } from './origins';

/** router-api's session cookie, set on the *API* host (ADR-004 §4). */
export const SESSION_COOKIE_NAME = 'cr_session';

/** The console's own routing marker, on the *console* host (SUP-113). */
export const SIGNED_IN_COOKIE_NAME = 'cr_signed_in';

export const SESSION_DATA = {
  me: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'developer@example.com',
    name: 'Dev Eloper',
    avatarUrl: null,
    workspaces: [
      {
        id: '00000000-0000-4000-8000-0000000000a1',
        name: 'Default Workspace',
        slug: 'default',
        role: 'OWNER',
        balanceMicros: '170650000',
      },
    ],
  },
};

/** The `data` object of a GraphQL response. */
export type OperationData = Record<string, unknown>;

/**
 * What router-api answers an operation it will not run without a session
 * (`session.guard.ts`), and what the console's Apollo error link recognises.
 */
export const UNAUTHENTICATED = 'unauthenticated' as const;

/** A canned answer, one computed from the operation's variables, or a refusal. */
export type OperationAnswer = OperationData | typeof UNAUTHENTICATED;
export type OperationResponder = OperationAnswer | ((variables: Record<string, unknown>) => OperationAnswer);

/** Operation name → the `data` the console gets back. */
export type GraphQLFixtures = Record<string, OperationResponder>;

/**
 * Answers the console's GraphQL calls from fixtures, keyed by operation name.
 *
 * A UI test should not depend on a database, so each screen's spec supplies the
 * operations it needs (`apps/router-api/schema.graphql` is the contract). An
 * operation nobody mocked fails loudly rather than returning an empty object:
 * a screen quietly rendering "no data" is exactly the bug these tests exist to
 * catch. Two are answered by default: `Session`, because every console page asks
 * for it, and `SignedIn` — the sign-in screen's probe — with the refusal a
 * visitor who is not signed in gets. {@link signIn} overrides the second.
 */
export async function mockGraphQL(page: Page, operations: GraphQLFixtures = {}): Promise<void> {
  const responses: GraphQLFixtures = { Session: SESSION_DATA, SignedIn: UNAUTHENTICATED, ...operations };

  await page.route('**/graphql', async (route) => {
    const body = route.request().postDataJSON() as {
      operationName?: string;
      variables?: Record<string, unknown>;
    };
    const name = body?.operationName ?? '';

    if (!(name in responses)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ errors: [{ message: `Unmocked operation: ${name}` }] }),
      });
      return;
    }

    const responder = responses[name];
    const answer = typeof responder === 'function' ? responder(body.variables ?? {}) : responder;

    if (answer === UNAUTHENTICATED) {
      // 200 with a GraphQL error, not a 401: the HTTP status of a GraphQL
      // response is 200 either way, and this is the shape router-api sends.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          errors: [{ message: 'Authentication is required', extensions: { code: 'UNAUTHENTICATED' } }],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: answer }),
    });
  });
}

/**
 * Puts the browser in the state a completed sign-in leaves it in — two cookies
 * on two hosts, which is the whole point of serving them separately.
 *
 * router-api's session cookie goes on the API's host, where the console can
 * never read it; the routing marker goes on the console's, where `proxy.ts`
 * can. A helper that set only the first would recreate the same-host accident
 * SUP-113 hid behind. Neither *value* means anything: the console never
 * inspects either, and the API here is mocked.
 */
export async function signIn(page: Page, baseURL: string, operations: GraphQLFixtures = {}): Promise<void> {
  await page.context().addCookies([
    { name: SESSION_COOKIE_NAME, value: 'e2e-session-token', url: API_ORIGIN },
    { name: SIGNED_IN_COOKIE_NAME, value: '1', url: baseURL },
  ]);
  await mockGraphQL(page, { SignedIn: { me: { id: SESSION_DATA.me.id } }, ...operations });
}

/**
 * Gives the page a Clipboard API, because the browser will not.
 *
 * `navigator.clipboard` exists only in a secure context. The console is served
 * from a named http origin here (`origins.ts` says why it cannot be loopback),
 * so the browser withholds it; a deployment is https and has it. The stand-in
 * is a real read/write clipboard, so an assertion still reads back what the
 * console actually put on it, and `CopyButton`'s failure path — which is what a
 * refused clipboard exercises — is unchanged.
 */
export async function mockClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let held = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          held = value;
          return Promise.resolve();
        },
        readText: () => Promise.resolve(held),
      },
    });
  });
}
