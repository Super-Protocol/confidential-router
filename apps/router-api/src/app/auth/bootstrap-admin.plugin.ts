import { createHash, timingSafeEqual } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, formCsrfMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';

/** Path under `AUTH_BASE_PATH`, so the full route is `POST /auth/bootstrap`. */
export const BOOTSTRAP_PATH = '/bootstrap';

export interface BootstrapAdminOptions {
  /** `auth.bootstrapToken`. The plugin is only registered when there is one. */
  token: string;
  /** `auth.bootstrapEmail` — the address the first account is created under. */
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
 * First sign-in for a deployment that has no other way in.
 *
 * A marketplace install has no mailer and no OAuth app, so none of the ordinary
 * sign-in paths can produce the first account. This one can, exactly once:
 * while `auth.bootstrapToken` is set **and** the `user` table is empty, posting
 * that token to `/auth/bootstrap` creates the first account — with its personal
 * workspace, through the same `databaseHooks` every other sign-in goes through —
 * and answers with a session cookie.
 *
 * Two conditions gate it and both are checked per request, not at boot:
 *
 *  - **no token configured** → the plugin is never registered, so Better Auth's
 *    router answers 404 on its own;
 *  - **a user already exists** → 404 here, before the token is even looked at.
 *
 * 404 rather than 403 is deliberate: once the deployment has an owner this
 * endpoint is not a thing that exists, and saying "forbidden" would confirm to
 * an unauthenticated caller that a bootstrap token is configured somewhere.
 *
 * A wrong token while bootstrap *is* open answers 401, because at that point
 * the caller can already learn availability from the public `signInOptions`
 * query, and telling them the token was wrong is the difference between a
 * retryable typo and a dead end.
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
              description: 'Creates the first account on a deployment that has no other sign-in path.',
              responses: {
                200: { description: 'The first account was created; the session cookie is set.' },
                401: { description: 'The token did not match.' },
                404: { description: 'Bootstrap is not configured, or the deployment already has a user.' },
              },
            },
          },
        },
        async (ctx) => {
          // Better Auth's own adapter, not the TypeORM projection of the same
          // table: this is the check the endpoint is gated on, so it reads
          // through the connection that is about to do the insert.
          if ((await ctx.context.adapter.count({ model: 'user' })) > 0) {
            throw new APIError('NOT_FOUND');
          }
          if (!secretsMatch(ctx.body.token, options.token)) {
            throw new APIError('UNAUTHORIZED', { message: 'The bootstrap token is not valid.' });
          }

          let user: Awaited<ReturnType<typeof ctx.context.internalAdapter.createUser>>;
          try {
            user = await ctx.context.internalAdapter.createUser(
              // Verified because this address was not proven by a mail round
              // trip but asserted by whoever configured the deployment, which
              // is a stronger claim, not a weaker one.
              { email: options.email, emailVerified: true, name: '' },
              { method: 'bootstrap-admin' },
            );
          } catch (error) {
            // The `user.email` unique index is what makes this endpoint
            // single-use under concurrency: two requests can both pass the
            // count above, and only one can insert. The loser is not an error —
            // by the time it failed, the deployment had been bootstrapped.
            if ((await ctx.context.adapter.count({ model: 'user' })) > 0) {
              throw new APIError('NOT_FOUND');
            }
            throw error;
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
