/**
 * A headless console session against a running router-api.
 *
 * Everything the demo needs — a signed-in user, a workspace, credits, an API
 * key — is obtained the way the console obtains it: a magic-link sign-in and
 * the GraphQL mutations behind the Credits and API keys screens. There is no
 * seeding path that reaches into the database, on purpose. A demo that inserted
 * its own rows would prove that the *database* works; this proves the product
 * does, and it fails the moment either surface changes shape.
 *
 * The magic link is read out of the router's log, because the development
 * mailer writes it there (`auth.magicLink.mailer: console`) and there is no
 * mail provider in a test. It is the same line `docker compose logs api` shows.
 */
import type { RouterProcess } from './router-process.js';

/** The console mailer's line: `Magic link for <email>: <url>`. */
const MAGIC_LINK_LINE = /Magic link for [^:]+: (\S+?)(?:\\n|"|\s|$)/;

export interface ConsoleSession {
  readonly cookie: string;
  readonly workspaceId: string;
  readonly email: string;
  /** The origin every request from this session carries. */
  readonly origin: string;
  /** Runs one GraphQL operation as this user. Throws on a GraphQL error. */
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface DemoCredential {
  /** The plaintext `sk-tee-v1-…` key. Shown once, by the product, and here. */
  secret: string;
  id: string;
  name: string;
}

/**
 * Signs a user in and returns the session cookie plus their workspace.
 *
 * `origin` is not decoration: Better Auth refuses a state-changing request that
 * arrives without one, and only accepts origins in `server.validClientOrigins`.
 * A browser sets it; this client has to say it out loud.
 */
export async function signIn(router: RouterProcess, email: string, origin: string): Promise<ConsoleSession> {
  const requested = await fetch(`${router.baseUrl}/auth/sign-in/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, callbackURL: '/' }),
  });
  if (!requested.ok) {
    throw new Error(`magic-link request failed: ${requested.status} ${await requested.text()}`);
  }

  const [, url] = await router.waitForLog(MAGIC_LINK_LINE);
  // The verify endpoint answers with a redirect and a Set-Cookie; following the
  // redirect would drop us on the console, which is not running here.
  const verified = await fetch(url, { redirect: 'manual' });
  const cookie = sessionCookieOf(verified);
  if (!cookie) {
    throw new Error(`the magic link did not set a session cookie: ${verified.status} ${await verified.text()}`);
  }

  const graphql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetch(`${router.baseUrl}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) {
      throw new Error(`GraphQL: ${body.errors.map((error) => error.message).join('; ')}`);
    }
    if (!body.data) {
      throw new Error(`GraphQL returned no data (${response.status})`);
    }
    return body.data;
  };

  const me = await graphql<{ me: { workspaces: { id: string }[] } }>(
    'query Me { me { id email workspaces { id name slug role } } }',
  );
  const workspaceId = me.me.workspaces[0]?.id;
  if (!workspaceId) {
    throw new Error('the signed-in user has no workspace; provisioning did not run');
  }

  return { cookie, workspaceId, email, origin, graphql };
}

/** Tops the workspace up through the manual payment provider (ADR-005 §4). */
export async function topUp(session: ConsoleSession, amountMicros: number): Promise<number> {
  const { createCheckout } = await session.graphql<{ createCheckout: { url: string } }>(
    'mutation TopUp($input: CreateCheckoutInput!) { createCheckout(input: $input) { url ref } }',
    { input: { workspaceId: session.workspaceId, amountMicros: String(amountMicros) } },
  );

  // Following the link *is* the payment: the manual provider credits the ledger
  // from the redirect, exactly where Stripe would credit it from a webhook.
  const completed = await fetch(createCheckout.url, { redirect: 'manual' });
  if (completed.status >= 400) {
    throw new Error(`manual checkout failed: ${completed.status} ${await completed.text()}`);
  }

  const balance = await session.graphql<{ creditBalance: { balanceMicros: string } }>(
    'query Balance($workspaceId: ID!) { creditBalance(workspaceId: $workspaceId) { balanceMicros spendable } }',
    { workspaceId: session.workspaceId },
  );
  return Number(balance.creditBalance.balanceMicros);
}

/** Mints a `/v1` credential. The secret is returned exactly once, as designed. */
export async function createApiKey(session: ConsoleSession, name: string): Promise<DemoCredential> {
  const { createApiKey: created } = await session.graphql<{
    createApiKey: { secret: string; key: { id: string; name: string } };
  }>('mutation NewKey($input: CreateApiKeyInput!) { createApiKey(input: $input) { secret key { id name } } }', {
    input: { workspaceId: session.workspaceId, name },
  });
  return { secret: created.secret, id: created.key.id, name: created.key.name };
}

function sessionCookieOf(response: Response): string | null {
  const raw = response.headers.getSetCookie?.() ?? [];
  const cookies = raw.map((entry) => entry.split(';')[0]).filter((entry) => entry.startsWith('cr_session='));
  return cookies.length > 0 ? cookies.join('; ') : null;
}
