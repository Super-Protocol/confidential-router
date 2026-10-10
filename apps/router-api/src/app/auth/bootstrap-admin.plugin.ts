import { createHash, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, formCsrfMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';

/**
 * Nest's logger, so the audit line below lands in the same stream as the rest
 * of the application's log rather than in Better Auth's own.
 */
const logger = new Logger('BootstrapAdmin');

/** Path under `AUTH_BASE_PATH`, so the full route is `POST /auth/bootstrap`. */
export const BOOTSTRAP_PATH = '/bootstrap';

export interface BootstrapAdminOptions {
  /** `auth.bootstrapToken`. The plugin is only registered when there is one. */
  token: string;
  /** `auth.bootstrapEmail` — the address the first account is created under, and the only one the token opens. */
  email: string;
}

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Both sides are hashed first so `timingSafeEqual` always gets two equal-length
 * buffers: it throws on a length mismatch, and a thrown-versus-returned
 * difference is itself an oracle for the token's length.
 */
export function secretsMatch(candidate: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

/**
 * The deployment's own token: first sign-in, and the administrator's way back.
 *
 * **First sign-in.** A fresh deployment has no account, and may have no mailer
 * and no OAuth app either, so none of the ordinary sign-in paths can produce
 * the first one. While `auth.bootstrapToken` is set **and** the `user` table is
 * empty, posting that token to `/auth/bootstrap` creates the first account —
 * with its personal workspace, through the same `databaseHooks` every other
 * sign-in goes through — and answers with a session cookie.
 *
 * **Break-glass (SUP-269).** Afterwards the same token signs back into *that*
 * account, the one at `auth.bootstrapEmail`, and into no other. Sign-in is a
 * code mailed to the address, so without this a deployment with no mailer — or
 * with one that is down — would lose its administrator for good the day the
 * session cookie did. It creates nothing: once the deployment has users, the
 * token can only open a session for an account that already exists. Unsetting
 * `auth.bootstrapToken` closes it.
 *
 * What gates it, checked per request and not at boot:
 *
 *  - **no token configured** → the plugin is never registered, so Better Auth's
 *    router answers 404 on its own;
 *  - **users exist, but not the bootstrap account** → 404, before the token is
 *    even looked at: there is nothing for it to open.
 *
 * 404 rather than 403 is deliberate: where the endpoint can do nothing it is
 * not a thing that exists, and saying "forbidden" would confirm to an
 * unauthenticated caller that a bootstrap token is configured somewhere.
 *
 * A wrong token where it *could* do something answers 401, because at that
 * point the caller can already learn availability from the public
 * `signInOptions` query, and telling them the token was wrong is the difference
 * between a retryable typo and a dead end.
 */
export function bootstrapAdmin(options: BootstrapAdminOptions): BetterAuthPlugin {
  return {
    id: 'bootstrap-admin',
    endpoints: {
      bootstrapAdmin: createAuthEndpoint(
        BOOTSTRAP_PATH,
        {
          method: 'POST',
          requireHeaders: true,
          use: [formCsrfMiddleware],
          body: z.object({
            token: z.string().meta({ description: 'The deployment’s auth.bootstrapToken.' }),
          }),
          metadata: {
            openapi: {
              operationId: 'bootstrapFirstAdmin',
              description:
                'Creates the first account on an empty deployment, or signs back into that account afterwards.',
              responses: {
                200: { description: 'The session cookie is set, for the bootstrap account.' },
                401: { description: 'The token did not match.' },
                404: {
                  description: 'Bootstrap is not configured, or its account does not exist on a claimed deployment.',
                },
              },
            },
          },
        },
        async (ctx) => {
          // Better Auth's own adapter, not the TypeORM projection of the same
          // table: this is the check the endpoint is gated on, so it reads
          // through the connection that is about to do the insert.
          const claimed = (await ctx.context.adapter.count({ model: 'user' })) > 0;
          const existing = claimed ? await ctx.context.internalAdapter.findUserByEmail(options.email) : null;
          if (claimed && !existing) {
            throw new APIError('NOT_FOUND');
          }
          if (!secretsMatch(ctx.body.token, options.token)) {
            throw new APIError('UNAUTHORIZED', { message: 'The bootstrap token is not valid.' });
          }

          let user: Awaited<ReturnType<typeof ctx.context.internalAdapter.createUser>>;
          if (existing) {
            // Break-glass: the token's own account, and only that one.
            user = existing.user;
            // A static credential has just opened an administrator session, and
            // nothing mailed anybody to say so. An operator has to be able to
            // see that it happened and from where — the account and the source,
            // never the token.
            logger.warn(
              `Break-glass sign-in: the bootstrap token opened a session for ${user.email} ` +
                `from ${sourceOf(ctx.headers)}. If nobody on your side did this, rotate auth.bootstrapToken.`,
            );
          } else {
            try {
              user = await ctx.context.internalAdapter.createUser(
                // Verified because this address was not proven by a mail round
                // trip but asserted by whoever configured the deployment, which
                // is a stronger claim, not a weaker one.
                { email: options.email, emailVerified: true, name: '' },
                { method: 'bootstrap-admin' },
              );
            } catch (error) {
              // The `user.email` unique index is what keeps creation single-use
              // under concurrency: two requests can both pass the count above,
              // and only one can insert. The loser signs into the account the
              // winner made — it presented the same token for the same address.
              const winner = await ctx.context.internalAdapter.findUserByEmail(options.email);
              if (!winner) {
                throw error;
              }
              user = winner.user;
            }
          }

          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) {
            throw new APIError('INTERNAL_SERVER_ERROR', { message: 'The bootstrap session could not be created.' });
          }
          await setSessionCookie(ctx, { session, user });

          // Deliberately not the session token: the cookie is the credential,
          // and echoing a bearer copy of it into a response body is one more
          // place for it to be logged by something in front of us.
          return ctx.json({ user: { id: user.id, email: user.email } });
        },
      ),
    },
    // Better Auth enables rate limiting in production only, which is where a
    // token this valuable is worth guessing. Five attempts a minute per source
    // makes an offline-speed search of a 16-character secret pointless.
    rateLimit: [{ pathMatcher: (path) => path === BOOTSTRAP_PATH, window: 60, max: 5 }],
  };
}

/**
 * Where a request came from, for the audit line: the first hop the proxy
 * reported, which is the same reading `sign-up-invite.ts` takes. It is a label
 * for an operator, not something a decision rests on.
 */
function sourceOf(headers: Headers | undefined): string {
  const forwarded = headers?.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || headers?.get('x-real-ip') || 'an unknown address';
}
