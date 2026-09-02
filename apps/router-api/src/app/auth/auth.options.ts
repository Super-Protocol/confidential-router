import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { magicLink } from 'better-auth/plugins/magic-link';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import type { RouterConfig } from '../config.schema.js';
import { bootstrapAdmin } from './bootstrap-admin.plugin.js';
import type { MagicLinkMailer } from './magic-link-mailer.js';

/** Session cookie name fixed by ADR-004 §4. */
export const SESSION_COOKIE_NAME = 'cr_session';

/** Better Auth is mounted here; `/auth/sign-in/*`, `/auth/callback/*`, … */
export const AUTH_BASE_PATH = '/auth';

/**
 * Better Auth's email-and-password routes, relative to {@link AUTH_BASE_PATH}.
 *
 * They are core routes rather than a plugin, so they are mounted whether or not
 * the provider is enabled — `emailAndPassword.enabled: false` only makes them
 * answer 400 "not enabled". `disabledPaths` turns that into the 404 magic link
 * and bootstrap already give when they are not configured: on this deployment a
 * sign-in path that is switched off is not a thing that exists.
 */
export const PASSWORD_PATHS = ['/sign-up/email', '/sign-in/email', '/change-password', '/verify-password'];

/**
 * Password reset, off on every deployment.
 *
 * It is a mail round trip, and password sign-in exists here precisely for the
 * deployment that has no mail — so it could only ever answer "reset password
 * isn't enabled". `/reset-password/:token` is not in the list because a path
 * parameter cannot be matched by an exact-path check; it is unreachable anyway,
 * since `/request-password-reset` is the only thing that mints a token it would
 * accept.
 */
export const PASSWORD_RESET_PATHS = ['/request-password-reset', '/reset-password'];

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
    // Off unless the deployment asked for it (ADR-004 §1, amended by SUP-112):
    // OAuth and magic link are better, and this is the only path that works
    // when neither is available.
    emailAndPassword: {
      enabled: auth.password.enabled,
      minPasswordLength: auth.password.minLength,
      // The whole point of this provider is a deployment with no mail. A
      // verification round trip nobody can complete would lock out every
      // account it created.
      requireEmailVerification: false,
      // Signing up answers with the session cookie, rather than asking for the
      // password that was just chosen a second time.
      autoSignIn: true,
    },
    disabledPaths: auth.password.enabled ? PASSWORD_RESET_PATHS : [...PASSWORD_PATHS, ...PASSWORD_RESET_PATHS],
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
    plugins: authPlugins(auth, mailer),
  };
}

/**
 * The plugins this deployment's configuration asks for, and only those.
 *
 * Both are conditional on purpose. An unregistered plugin's routes 404 from
 * Better Auth's own router, which is a stronger statement than a handler that
 * exists and refuses: there is no `/auth/bootstrap` to probe on a deployment
 * that configured no token, and no `/auth/sign-in/magic-link` to request a mail
 * from on one that has no mailer.
 */
function authPlugins(auth: RouterConfig['auth'], mailer: MagicLinkMailer): BetterAuthPlugin[] {
  const plugins: BetterAuthPlugin[] = [];

  if (auth.magicLink.mailer !== 'none') {
    plugins.push(
      magicLink({
        sendMagicLink: async ({ email, url, token }) => {
          await mailer.send({ email, url, token });
        },
      }),
    );
  }

  if (auth.bootstrapToken !== undefined) {
    plugins.push(bootstrapAdmin({ token: auth.bootstrapToken, email: auth.bootstrapEmail }));
  }

  return plugins;
}
