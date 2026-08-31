import type { Page } from '@playwright/test';

/** Mirrors `SESSION_COOKIE_NAME` in the app (ADR-004 §4). */
export const SESSION_COOKIE_NAME = 'cr_session';

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

/** A canned response, or one computed from the operation's variables. */
export type OperationResponder = OperationData | ((variables: Record<string, unknown>) => OperationData);

/** Operation name → the `data` the console gets back. */
export type GraphQLFixtures = Record<string, OperationResponder>;

/**
 * Answers the console's GraphQL calls from fixtures, keyed by operation name.
 *
 * A UI test should not depend on a database, so each screen's spec supplies the
 * operations it needs (`apps/router-api/schema.graphql` is the contract). An
 * operation nobody mocked fails loudly rather than returning an empty object:
 * a screen quietly rendering "no data" is exactly the bug these tests exist to
 * catch. `Session` is mocked by default, because every console page asks for it.
 */
export async function mockGraphQL(page: Page, operations: GraphQLFixtures = {}): Promise<void> {
  const responses: GraphQLFixtures = { Session: SESSION_DATA, ...operations };

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
    const data = typeof responder === 'function' ? responder(body.variables ?? {}) : responder;

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data }),
    });
  });
}

/**
 * Puts the browser in the state a completed sign-in leaves it in: the session
 * cookie set by router-api, and an API that answers the session query.
 *
 * The cookie's *value* is deliberately meaningless — the console never inspects
 * it, and a test that pretended otherwise would be testing a boundary the UI
 * does not own.
 */
export async function signIn(page: Page, baseURL: string, operations: GraphQLFixtures = {}): Promise<void> {
  await page.context().addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: 'e2e-session-token',
      url: baseURL,
    },
  ]);
  await mockGraphQL(page, operations);
}
