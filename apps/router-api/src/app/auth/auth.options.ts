import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { magicLink } from 'better-auth/plugins/magic-link';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import type { RouterConfig } from '../config.schema.js';
import { type SignUpInvite, signUpInviteOf } from '../invites/sign-up-invite.js';
import { magicLinkEnabled, passwordResetEnabled } from '../mail/mail-settings.js';
import { bootstrapAdmin } from './bootstrap-admin.plugin.js';
import { isBootstrapSignUp, type SignUpMethod, signUpMethodOf } from './sign-up-method.js';

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
 * Password reset, off unless the deployment has both a password to reset and a
 * mailer to deliver the link (SUP-269, `passwordResetEnabled`).
 *
 * Off, it could only ever answer "reset password isn't enabled", so it is a 404
 * instead, like every other path this deployment does not offer.
 * `/reset-password/:token` is not in the list because a path parameter cannot
 * be matched by an exact-path check; it is unreachable anyway, since
 * `/request-password-reset` is the only thing that mints a token it would
 * accept. The console never uses it even when reset is on: the mailed link
 * goes straight to the console's own reset page.
 */
export const PASSWORD_RESET_PATHS = ['/request-password-reset', '/reset-password'];

/**
 * What the auth flows need from the mail service — narrower than
 * `MailService`, so this file stays a function of its inputs.
 */
export interface AuthMail {
  /** Awaited: the requester is waiting for the link, and a failure is theirs to see. */
  sendMagicLink(email: string, url: string): Promise<void>;
  /** Fire-and-forget: see `MailService.requestPasswordReset` for why it must not be awaited. */
  requestPasswordReset(email: string, token: string): void;
}

export interface AuthOptionsDeps {
  config: RouterConfig;
  mail: AuthMail;
  /** Injected so tests can close the handle they own. */
  database: BetterAuthOptions['database'];
  /**
   * Provisions the personal workspace on first sign-in (ADR-004 §5), spends the
   * invitation code the creating request carried, if any (SUP-142), and reports
   * the sign-up to analytics (SUP-145).
   *
   * It receives the invitation context and the method rather than fetching
   * either, because the only place both exist is the request Better Auth is
   * handling — see `sign-up-invite.ts` for why that request differs per sign-in
   * path, and `sign-up-method.ts` for why the provider is not yet readable from
   * the database when this runs.
   */
  onUserCreated?: (
    user: { id: string; email: string; name?: string | null },
    invite: SignUpInvite,
    method: SignUpMethod,
  ) => Promise<void>;
  /**
   * Decides whether an account may be created at all (`SignUpGate`, SUP-173).
   *
   * Runs before the insert, on every path, and throws Better Auth's `APIError`
   * to refuse — which is what turns into a 403 for a password sign-up and into
   * an `?error=<code>` redirect for the two that arrive as navigations.
   *
   * It must not write. Better Auth holds an open read transaction across this
   * hook, and a second connection writing into it deadlocks SQLite outright
   * (`SQLITE_BUSY`, immediately, in WAL as well as in the default journal mode —
   * a read snapshot cannot be upgraded past another connection's commit). That
   * is why the invitation *seat* is still claimed where it always was, inside
   * the grant that follows the insert, and this hook only reads.
   *
   * Only registered alongside `onUserCreated`: the two halves of one sign-up are
   * either both wired or neither is.
   */
  onBeforeUserCreated?: (invite: SignUpInvite, bootstrap: boolean) => Promise<void>;
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

export function buildAuthOptions({
  config,
  mail,
  database,
  onUserCreated,
  onBeforeUserCreated,
}: AuthOptionsDeps): BetterAuthOptions {
  const { auth, server } = config;
  const resetOffered = passwordResetEnabled(config);

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
      // Better Auth answers `/request-password-reset` identically whether or
      // not the address has an account, and only calls this for one that does.
      // The link it builds is ignored: it points at the API's own redirect
      // endpoint and carries a client-chosen `redirectTo`, where the mailed link
      // should go straight to the console and depend on nothing the requester
      // sent.
      sendResetPassword: resetOffered
        ? async ({ user, token }) => {
            mail.requestPasswordReset(user.email, token);
          }
        : undefined,
      resetPasswordTokenExpiresIn: Math.floor(auth.passwordReset.tokenTtl / 1000),
      // A reset is what someone does when they think the password is known to
      // somebody else, so every session that password opened ends with it.
      revokeSessionsOnPasswordReset: true,
    },
    disabledPaths: [...(auth.password.enabled ? [] : PASSWORD_PATHS), ...(resetOffered ? [] : PASSWORD_RESET_PATHS)],
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
              before: onBeforeUserCreated
                ? async (_user, context) => onBeforeUserCreated(signUpInviteOf(context), isBootstrapSignUp(context))
                : undefined,
              after: async (user, context) => {
                await onUserCreated(
                  { id: user.id, email: user.email, name: user.name },
                  signUpInviteOf(context),
                  signUpMethodOf(context),
                );
              },
            },
          },
        }
      : undefined,
    plugins: authPlugins(config, mail),
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
function authPlugins(config: RouterConfig, mail: AuthMail): BetterAuthPlugin[] {
  const { auth } = config;
  const plugins: BetterAuthPlugin[] = [];

  if (magicLinkEnabled(config)) {
    plugins.push(
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await mail.sendMagicLink(email, url);
        },
      }),
    );
  }

  if (auth.bootstrapToken !== undefined) {
    plugins.push(bootstrapAdmin({ token: auth.bootstrapToken, email: auth.bootstrapEmail }));
  }

  return plugins;
}
