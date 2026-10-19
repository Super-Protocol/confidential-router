import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { type SignUpInvite, signUpInviteOf } from '../invites/sign-up-invite.js';
import { EMAIL_CODE_SEND_PATH } from '../mail/email-code-throttle.js';

/**
 * Asks for a magic link — the other route that mails an address which may have
 * no account. Relative to `AUTH_BASE_PATH`, as Better Auth matches it, like
 * {@link EMAIL_CODE_SEND_PATH} beside it.
 */
export const MAGIC_LINK_SEND_PATH = '/sign-in/magic-link';

export interface SignUpMailGateOptions {
  /**
   * `SignUpGate.admits` — the invite-only decision as a read that answers
   * instead of throwing.
   */
  admits: (invite: SignUpInvite) => Promise<boolean>;
}

/**
 * The invitation requirement, one step earlier: a deployment that will not
 * create the account does not mail it a credential either (SUP-410).
 *
 * `SignUpGate` holds the account — it runs in `databaseHooks.user.create.before`,
 * where nothing can be created without a usable code. The two routes that *mail*
 * something are one step in front of that hook, and they ran without it: an
 * unauthenticated caller could post any address to
 * `/auth/email-otp/send-verification-otp` and have a sign-in code delivered to
 * it, on a deployment whose invitation gate then refused the account one request
 * later. Nothing was created, so the gate was never wrong; the mail had already
 * gone out. That made the deployment's verified sender an open mail relay for
 * whoever found the hostname — a spent quota, and our domain in strangers'
 * inboxes and spam complaints.
 *
 * So both send routes ask the same question the insert asks, before they send:
 *
 *  - **the address has an account** → a sign-in, and untouched. The invitation
 *    requirement is about accounts coming into existence and has never had
 *    anything to say about this request.
 *  - **it does not** → this is the first half of a sign-up, and it goes ahead
 *    only while the request carries a code `SignUpGate` would admit.
 *
 * **A refusal is indistinguishable from a send.** The route's own success body is
 * returned, from this hook, without the handler running: no mail, no code
 * stored, and the same `200` either way. That is the point — answering
 * differently would turn the endpoint into an oracle for which addresses have
 * accounts, which is precisely what `disableSignUp: false` and the uniform 200
 * were chosen to avoid. The reason lives in the log (`SignUpGate.admits`) and
 * nowhere else.
 *
 * Registered only on an invite-only deployment, so an open one keeps the routes
 * it always had, with no extra read per request and nothing to reason about.
 */
export function signUpMailGate({ admits }: SignUpMailGateOptions): BetterAuthPlugin {
  return {
    id: 'sign-up-mail-gate',
    hooks: {
      before: [
        {
          // `sign-in` is the only type this deployment mails at all; the routes
          // behind the other two are disabled (`UNUSED_EMAIL_OTP_PATHS`), and
          // none of them creates an account.
          matcher: (context) => context.path === EMAIL_CODE_SEND_PATH && typeOf(context.body) === 'sign-in',
          handler: createAuthMiddleware(async (context) =>
            (await mayMailSignUp(context, admits)) ? undefined : context.json({ success: true }),
          ),
        },
        {
          matcher: (context) => context.path === MAGIC_LINK_SEND_PATH,
          handler: createAuthMiddleware(async (context) =>
            (await mayMailSignUp(context, admits)) ? undefined : context.json({ status: true }),
          ),
        },
      ],
    },
  };
}

/**
 * Whether this request may be mailed — the whole decision, and the part worth
 * testing on its own.
 *
 * Everything it reads is on the request Better Auth is already handling: a
 * `before` hook sees the body as it arrived, which is where an invitation code
 * rides on the email-code route (`inviteCode`) and inside `callbackURL` on the
 * magic-link one — see `sign-up-invite.ts` for the four places a code can be.
 */
export async function mayMailSignUp(
  context: MailGateContext,
  admits: SignUpMailGateOptions['admits'],
): Promise<boolean> {
  const email = emailOf(context.body);
  if (!email) {
    // Not a request this can judge — the route's own validation answers it.
    return true;
  }
  if (await context.context.internalAdapter.findUserByEmail(email)) {
    return true;
  }
  return admits(signUpInviteOf(context));
}

/**
 * What the decision needs from Better Auth's hook context, declared
 * structurally so it can be tested without constructing one — the same reading
 * `sign-up-invite.ts` takes of the context it extracts an invitation from.
 */
export interface MailGateContext {
  body?: unknown;
  query?: unknown;
  headers?: { get(name: string): string | null } | null;
  request?: { headers?: { get(name: string): string | null } | null } | null;
  context: {
    internalAdapter: {
      findUserByEmail(email: string): Promise<unknown>;
    };
  };
}

/**
 * The address this request is about, lower-cased as both routes and the `user`
 * table hold it, or nothing when the body does not carry one.
 */
function emailOf(body: unknown): string | null {
  const email = asRecord(body)?.email;
  return typeof email === 'string' && email.trim().length > 0 ? email.trim().toLowerCase() : null;
}

/** The email-code route's `type`, which decides whether this is a sign-in code at all. */
function typeOf(body: unknown): unknown {
  return asRecord(body)?.type;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
