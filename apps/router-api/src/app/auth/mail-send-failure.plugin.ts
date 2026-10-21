import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { EMAIL_CODE_SEND_PATH } from '../mail/email-code-throttle.js';

/**
 * What the console reads to tell "we could not mail it" apart from everything
 * else these two routes answer. One name for both of them: the viewer's
 * situation is the same whether the code or the link is the one that did not
 * leave the process.
 */
export const MAIL_SEND_FAILED = 'MAIL_SEND_FAILED';

/**
 * The refusal the requester gets, for either mail step.
 *
 * Says nothing about the provider, the host, the account or the address. The
 * reason lives in the log and in `/health`, where `MailService.status()` puts
 * it; out here it would be an unauthenticated reader's view of the
 * deployment's mail plumbing.
 */
export function mailSendFailure(what: 'code' | 'link'): APIError {
  return new APIError('SERVICE_UNAVAILABLE', {
    code: MAIL_SEND_FAILED,
    message: `The sign-in ${what} could not be sent. Try again in a moment.`,
  });
}

/**
 * Where a failed send parks itself until the after hook can answer with it.
 *
 * Module-local, so nothing outside this file can set it, and a symbol so it
 * cannot collide with a key Better Auth or a plugin keeps on the same object.
 */
const FAILED = Symbol('mail-send-failed');

/**
 * The one thing this needs from Better Auth's endpoint context: `context`, the
 * per-request object the handler and the after hook both hold a reference to.
 * Declared structurally, like `MailGateContext` beside it, so the hook and the
 * callback can be tested without constructing a real one.
 */
export interface MailSendContext {
  context?: object | null;
}

/**
 * Records that this request's mail did not go out, and says whether it could.
 *
 * `false` means there was no request to record against — an `auth.api.*` call
 * made without one — and the caller should let the error travel instead.
 */
export function recordMailSendFailure(context: MailSendContext | null | undefined): boolean {
  const request = context?.context;
  if (!request) {
    return false;
  }
  (request as Record<symbol, unknown>)[FAILED] = true;
  return true;
}

/** Whether {@link recordMailSendFailure} ran for this request. */
export function mailSendFailed(context: MailSendContext | null | undefined): boolean {
  const request = context?.context;
  return request !== null && request !== undefined && (request as Record<symbol, unknown>)[FAILED] === true;
}

/**
 * Makes a sign-in code that was never sent a failed request (SUP-460).
 *
 * `POST /auth/email-otp/send-verification-otp` answered `200 {"success":
 * true}` for a code that never reached the mail provider, for days, on the
 * production deployment — and sign-in there is by emailed code only, so every
 * account was locked out while the router reported success. `MailService`
 * had done its part: `sendSignInCode` delivers with `rethrow: true` precisely
 * so a failed send rejects. It is the route that loses it. Better Auth hands
 * the `sendVerificationOTP` callback's promise to `runInBackgroundOrAwait`,
 * which awaits it and then catches and logs whatever it rejects with, and
 * returns its `{"success": true}` either way. Nothing a callback throws can
 * change that answer.
 *
 * An after hook can, so the failure travels the one step between them on the
 * request itself and this turns it into a 503. The alternative — refusing in
 * front of the route on `MailService.status()` — would answer for sends that
 * have not been tried yet and would still have said 200 to every one of the
 * production requests, because the status only turns `failing` after a send
 * has already failed.
 *
 * **It is still the same answer for every address.** The failure this reports
 * is the transport's and has nothing to do with who asked: an outage refuses
 * an account holder and a stranger alike, which is what keeps the route from
 * becoming an account-existence oracle. The two cases that deliberately send
 * nothing — an address past its hourly allowance, and a sign-up an invite-only
 * deployment would refuse — do not fail, so they keep answering 200 exactly as
 * they did.
 *
 * The magic-link route needs none of this: it awaits its callback itself, so
 * {@link mailSendFailure} thrown from there is already the answer.
 */
export function reportMailSendFailure(): BetterAuthPlugin {
  return {
    id: 'mail-send-failure',
    hooks: {
      after: [
        {
          matcher: (context) => context.path === EMAIL_CODE_SEND_PATH,
          handler: createAuthMiddleware(async (context) => {
            if (mailSendFailed(context)) {
              throw mailSendFailure('code');
            }
          }),
        },
      ],
    },
  };
}
