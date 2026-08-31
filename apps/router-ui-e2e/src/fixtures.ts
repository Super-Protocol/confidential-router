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

/**
 * Answers the console's GraphQL calls from a fixture.
 *
 * A shell smoke test should not depend on a database, so the fixture answers
 * the `Session` query router-api serves (`apps/router-api/schema.graphql`).
 * Anything the shell does not know how to ask for fails loudly rather than
 * returning an empty object.
 */
export async function mockGraphQL(page: Page, data: unknown = SESSION_DATA): Promise<void> {
  await page.route('**/graphql', async (route) => {
    const body = route.request().postDataJSON() as { operationName?: string };

    if (body?.operationName !== 'Session') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ errors: [{ message: `Unmocked operation: ${body?.operationName}` }] }),
      });
      return;
    }

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
export async function signIn(page: Page, baseURL: string): Promise<void> {
  await page.context().addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: 'e2e-session-token',
      url: baseURL,
    },
  ]);
  await mockGraphQL(page);
}
