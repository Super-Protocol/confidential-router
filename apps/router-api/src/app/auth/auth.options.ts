import type { BetterAuthOptions } from 'better-auth';
import { magicLink } from 'better-auth/plugins/magic-link';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import type { RouterConfig } from '../config.schema.js';
import type { MagicLinkMailer } from './magic-link-mailer.js';

/** Session cookie name fixed by ADR-004 §4. */
export const SESSION_COOKIE_NAME = 'cr_session';

/** Better Auth is mounted here; `/auth/sign-in/*`, `/auth/callback/*`, … */
export const AUTH_BASE_PATH = '/auth';

export interface AuthOptionsDeps {
  config: RouterConfig;
  mailer: MagicLinkMailer;
  /** Injected so tests can close the handle they own. */
  database: BetterAuthOptions['database'];
  /** Provisions the personal workspace on first sign-in (ADR-004 §5). */
  onUserCreated?: (user: { id: string; email: string; name?: string | null }) => Promise<void>;
}

/**
 * Better Auth talks to the same database as everything else (ADR-004 §2) but
 * through its own connection: it uses Kysely, TypeORM uses its own pool, and
 * giving each its own handle keeps a schema change on one side from being a
 * runtime concern on the other.
 */
export function createAuthDatabase(config: RouterConfig): BetterAuthOptions['database'] {
  if (config.database.type === 'sqlite') {
    return new Database(config.database.file);
  }
  return new Pool({ connectionString: config.database.url });
}

export function buildAuthOptions({ config, mailer, database, onUserCreated }: AuthOptionsDeps): BetterAuthOptions {
  const { auth, server } = config;

  return {
    appName: 'confidential-router',
    baseURL: auth.baseUrl,
    basePath: AUTH_BASE_PATH,
    secret: auth.secret,
    database,
    // This product exists because its users care where their data goes. Sending
    // usage pings to a third party by default would be a poor first impression.
    telemetry: { enabled: false },
    trustedOrigins: server.validClientOrigins,
    // No passwords anywhere: OAuth and magic link only (ADR-004 §1).
    emailAndPassword: { enabled: false },
    socialProviders: {
      ...(auth.github ? { github: { clientId: auth.github.clientId, clientSecret: auth.github.clientSecret } } : {}),
      ...(auth.google ? { google: { clientId: auth.google.clientId, clientSecret: auth.google.clientSecret } } : {}),
    },
    session: {
      expiresIn: Math.floor(auth.sessionMaxAge / 1000),
      // Rolling: a session in daily use is refreshed rather than expiring at 30 days.
      updateAge: Math.floor(auth.sessionMaxAge / 1000 / 30),
    },
    advanced: {
      cookiePrefix: 'cr',
      cookies: {
        session_token: {
          name: SESSION_COOKIE_NAME,
          attributes: {
            httpOnly: true,
            sameSite: 'lax',
            secure: auth.baseUrl.startsWith('https://'),
            path: '/',
          },
        },
      },
    },
    databaseHooks: onUserCreated
      ? {
          user: {
            create: {
              after: async (user) => {
                await onUserCreated({ id: user.id, email: user.email, name: user.name });
              },
            },
          },
        }
      : undefined,
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url, token }) => {
          await mailer.send({ email, url, token });
        },
      }),
    ],
  };
}
