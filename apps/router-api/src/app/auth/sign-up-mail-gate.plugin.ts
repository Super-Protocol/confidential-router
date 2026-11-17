import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { INVITE_QUERY_PARAM, type SignUpInvite, signUpInviteOf } from '../invites/sign-up-invite.js';
import { EMAIL_CODE_SEND_PATH } from '../mail/email-code-throttle.js';

/**
 * Asks for a magic link — the other route that mails an address which may have
 * no account. Relative to `AUTH_BASE_PATH`, as Better Auth matches it, like
 * {@link EMAIL_CODE_SEND_PATH} beside it.
 */
export const MAGIC_LINK_SEND_PATH = '/sign-in/magic-link';

/** `SignUpGate.admits` — the invite-only decision as a read that answers instead of throwing. */
export type AdmitsSignUp = (invite: SignUpInvite) => Promise<boolean>;

/**
 * Whether this deployment may mail the address a sign-in credential (SUP-410).
 *
 * `SignUpGate` holds the account: it runs in `databaseHooks.user.create.before`,
 * where nothing can be created without a usable code. It does not, by itself,
 * hold the **mail** — and the two requests that send some are one step in front
 * of that hook, so they ran without it. An unauthenticated caller could post any
 * address to `/auth/email-otp/send-verification-otp` (or to
 * `/auth/sign-in/magic-link`) and have a sign-in credential delivered to it on a
 * deployment whose invitation gate then refused the account one request later.
 * Nothing was created, so the gate was never wrong; the mail had already gone
 * out, which made the deployment's verified sender an open relay for whoever
 * found the hostname.
 *
 * So both mail steps ask the same question the insert asks, before they send:
 *
 *  - **the address has an account** → a sign-in, and untouched. The invitation
 *    requirement is about accounts coming into existence and has never had
 *    anything to say about this request.
 *  - **it does not** → this is the first half of a sign-up, and the mail goes
 *    out only while the request carries a code `SignUpGate` would admit.
 *
 * **Where this is asked is the whole design.** It is the mail callback — the one
 * statement that hands a credential to the outside world — and not a hook in
 * front of the route. A hook that answered early would have to decide which
 * requests it covers, and every answer to that question is a list: list the
 * `type`s that can mail and an upstream default silently adds one outside the
 * list; list the paths and the request that gets past the list is answered by
 * *us* rather than by the route, which makes our 200 for an unknown address
 * differ from the route's 400 for a known one — an account-existence oracle in
 * the fix that exists to prevent exactly that. From here there is no list:
 * every send of every type on both routes passes through, and the route answers
 * every request exactly as it always did.
 *
 * **A refusal is therefore indistinguishable from a send.** The route runs to
 * completion and returns its own body — `200 {"success": true}` for the code,
 * `{"status": true}` for the link — and the only difference is that nothing left
 * the process. The reason lives in the log (`SignUpGate.admits`) and nowhere
 * else.
 *
 * Only consulted on an invite-only deployment: nowhere else is a sign-up refused
 * at all, so nowhere else is there a mail to withhold.
 */
export async function mayMailSignUp(
  email: string,
  context: MailGateContext | null | undefined,
  admits: AdmitsSignUp,
): Promise<boolean> {
  const address = email.trim().toLowerCase();
  // No context means no request to read: no adapter to ask whether the address
  // has an account, and no invitation either. Nothing in the application calls
  // `auth.api.sendVerificationOTP` or `auth.api.signInMagicLink` directly, so
  // this is unreachable today — and the safe reading of it is the one that lets
  // the gate refuse.
  const adapter = context?.context?.internalAdapter;
  if (adapter && (await adapter.findUserByEmail(address))) {
    return true;
  }
  return admits(signUpInviteOf(context));
}

/**
 * Carries the invitation past the send route's body schema, so
 * {@link mayMailSignUp} can still see it.
 *
 * `POST /auth/email-otp/send-verification-otp` declares a strict body of
 * `{ email, type }`, and Better Call replaces the request body with the
 * validated value — so an `inviteCode` the console sends is gone by the time the
 * mail callback runs. A `before` hook sees the body as it arrived, which makes
 * it the one place that can hand the code forward; it puts it in the query,
 * which this route does not validate and which `sign-up-invite.ts` already reads
 * as one of the five places a code can be.
 *
 * **Carrying only.** It makes no decision and refuses nothing, so it is not a
 * security boundary and its matcher cannot become one: a request it fails to
 * match arrives at the gate with no invitation on it, which is refused. The
 * failure mode of this hook is an invited sign-up that stops working — loudly,
 * and pinned by `email-code.e2e.spec.ts` — rather than an open relay.
 *
 * The magic-link route needs no such help: it declares `callbackURL`, so the
 * code the console puts on that URL survives validation and the gate reads it
 * there.
 */
export function signUpInviteCarrier(): BetterAuthPlugin {
  return {
    id: 'sign-up-invite-carrier',
    hooks: {
      before: [
        {
          matcher: (context) => context.path === EMAIL_CODE_SEND_PATH,
          handler: createAuthMiddleware(async (context) => {
            const { code } = signUpInviteOf(context);
            if (!code) {
              return;
            }
            // Better Auth's own way for a hook to amend the request. The body is
            // not an option: the route's schema is about to replace it.
            return { context: { query: { ...asRecord(context.query), [INVITE_QUERY_PARAM]: code } } };
          }),
        },
      ],
    },
  };
}

/**
 * What the decision needs from Better Auth's endpoint context, declared
 * structurally so it can be tested without constructing one — the same reading
 * `sign-up-invite.ts` takes of the context it extracts an invitation from, plus
 * the adapter the account lookup goes through.
 */
export interface MailGateContext {
  body?: unknown;
  query?: unknown;
  headers?: { get(name: string): string | null } | null;
  request?: { headers?: { get(name: string): string | null } | null } | null;
  context?: {
    internalAdapter?: {
      findUserByEmail(email: string): Promise<unknown>;
    };
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
