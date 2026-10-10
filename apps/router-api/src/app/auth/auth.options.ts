import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { magicLink } from 'better-auth/plugins/magic-link';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import type { RouterConfig } from '../config.schema.js';
import { type SignUpInvite, signUpInviteOf } from '../invites/sign-up-invite.js';
import { emailCodeEnabled, magicLinkEnabled } from '../mail/mail-settings.js';
import { bootstrapAdmin } from './bootstrap-admin.plugin.js';
import { isBootstrapSignUp, type SignUpMethod, signUpMethodOf } from './sign-up-method.js';

/** Session cookie name fixed by ADR-004 §4. */
export const SESSION_COOKIE_NAME = 'cr_session';

/** Better Auth is mounted here; `/auth/sign-in/*`, `/auth/callback/*`, … */
export const AUTH_BASE_PATH = '/auth';

/**
 * Every Better Auth route that reads, sets or resets a password, relative to
 * {@link AUTH_BASE_PATH} — all of them a 404 on every deployment (SUP-269).
 *
 * Password sign-in is gone: accounts are proven by a code mailed to their
 * address, and no hash is stored. These are core routes rather than a plugin,
 * so they are mounted whatever the configuration says —
 * `emailAndPassword.enabled: false` only makes some of them answer 400 "not
 * enabled", and `/reset-password` would still *create* a credential for an
 * account that has none. `disabledPaths` is what makes them not exist.
 */
export const PASSWORD_PATHS = [
  '/sign-up/email',
  '/sign-in/email',
  '/change-password',
  '/verify-password',
  '/request-password-reset',
  '/reset-password',
];

/**
 * The parts of the email-OTP plugin this deployment does not use, switched off
 * the same way. The plugin mounts a password-reset-by-code flow and an
 * email-change flow next to the sign-in one; the first would mint the very
 * credential SUP-269 removed, and the second is a feature nobody asked for
 * with an account-takeover shape.
 */
export const UNUSED_EMAIL_OTP_PATHS = [
  '/email-otp/request-password-reset',
  '/forget-password/email-otp',
  '/email-otp/reset-password',
  '/email-otp/verify-email',
  '/email-otp/check-verification-otp',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
];

/** Digits in a sign-in code. Six is what every authenticator has taught people to expect. */
export const EMAIL_CODE_LENGTH = 6;

/**
 * What the auth flows need from the mail service — narrower than
 * `MailService`, so this file stays a function of its inputs.
 *
 * Both are awaited and reject when the mail could not be sent. Neither leaks
 * anything by that — see `MailService`.
 */
export interface AuthMail {
  sendMagicLink(email: string, url: string): Promise<void>;
  sendSignInCode(email: string, code: string): Promise<void>;
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
    // Off, everywhere and unconditionally (SUP-269): sign-in is a code mailed
    // to the address, OAuth, or the bootstrap token. Nothing here can create,
    // check or change a password, and `dropStoredCredentials` removes the
    // hashes earlier versions stored.
    emailAndPassword: { enabled: false },
    disabledPaths: [...PASSWORD_PATHS, ...UNUSED_EMAIL_OTP_PATHS],
    socialProviders: {
      ...(auth.github ? { github: { clientId: auth.github.clientId, clientSecret: auth.github.clientSecret } } : {}),
      ...(auth.google ? { google: { clientId: auth.google.clientId, clientSecret: auth.google.clientSecret } } : {}),
    },
    session: {
      expiresIn: Math.floor(auth.sessionMaxAge / 1000),
      // Rolling: a session in use is refreshed rather than expiring at
      // `sessionMaxAge` — at most once per thirtieth of it, so a console left
      // open does not write to the session table on every request.
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
 * All are conditional on purpose. An unregistered plugin's routes 404 from
 * Better Auth's own router, which is a stronger statement than a handler that
 * exists and refuses: there is no `/auth/bootstrap` to probe on a deployment
 * that configured no token, and no `/auth/email-otp/send-verification-otp` to
 * request a mail from on one that has no mailer.
 */
function authPlugins(config: RouterConfig, mail: AuthMail): BetterAuthPlugin[] {
  const { auth } = config;
  const plugins: BetterAuthPlugin[] = [];

  if (emailCodeEnabled(config)) {
    plugins.push(
      emailOTP({
        otpLength: EMAIL_CODE_LENGTH,
        expiresIn: Math.floor(auth.emailCode.ttl / 1000),
        allowedAttempts: auth.emailCode.attempts,
        // Only a digest of the code is stored, so a database read does not hand
        // out a sign-in for the next ten minutes.
        storeOTP: 'hashed',
        // An unknown address is mailed a code like any other, and the account
        // is created when the code comes back — subject to `SignUpGate`, which
        // is where an invite-only deployment refuses. That is also what makes
        // the send route answer identically for every address.
        disableSignUp: false,
        sendVerificationOTP: async ({ email, otp, type }) => {
          // The send route accepts three types and this deployment uses one;
          // the other two belong to flows whose routes are disabled above, and
          // mailing a code nothing will accept would only be noise.
          if (type !== 'sign-in') {
            return;
          }
          await mail.sendSignInCode(email, otp);
        },
      }),
    );
  }

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
