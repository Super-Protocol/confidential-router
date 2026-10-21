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
 * The part of `MailService.status()` the refusal is decided from — structural,
 * so this file stays a function of its inputs and the decision can be tested
 * without a mail service.
 */
export interface MailStateReader {
  status(): { state: 'disabled' | 'unverified' | 'ok' | 'failing' };
}

/**
 * Whether this deployment's mailer is known to be down — its last check or
 * send did not work (`mail.service.ts`, surfaced by `/health` as
 * `mail.state`).
 *
 * This, and not what happened to the request in hand, is what a refusal is a
 * function of. See {@link reportMailSendFailure}.
 */
export function mailerFailing(mail: MailStateReader): boolean {
  return mail.status().state === 'failing';
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
 * Makes a sign-in code that was never sent a failed request.
 *
 * `POST /auth/email-otp/send-verification-otp` answers `200 {"success":
 * true}` for a code the mailer could not get out. `MailService` does its part:
 * `sendSignInCode` delivers with `rethrow: true` precisely so a failed send
 * rejects, and it logs and records the failure. It is the route that loses it.
 * Better Auth hands the `sendVerificationOTP` callback's promise to
 * `runInBackgroundOrAwait`, which awaits it and then catches and logs whatever
 * it rejects with, and returns its `{"success": true}` either way. Nothing a
 * callback throws can change that answer.
 *
 * Found while diagnosing SUP-460 — a report of production dropping sign-in
 * mail silently, which turned out to be `#131`'s invite gate withholding mail
 * from uninvited addresses exactly as designed. Nothing was failing. But the
 * two are indistinguishable from outside, which is how a working deployment
 * came to be read as a broken one, and a *genuine* mail outage would have been
 * just as silent: on a deployment where sign-in is by emailed code only, every
 * account would have been locked out while the router answered success. That
 * is the latent defect this closes. The withheld half is SUP-462's.
 *
 * An after hook can change the answer, so the failure travels the one step
 * between them on the request itself.
 *
 * **The refusal is a function of the mailer, not of this request.** Refusing
 * only the requests that got as far as a failed send would build the thing
 * `#131` exists to prevent: on an invite-only deployment the gate returns
 * before the send for an address with no account and no invitation, so during
 * an outage an account holder would get a 503 and a stranger a 200 —
 * unauthenticated account enumeration, available exactly when the mailer is
 * down. So the hook refuses on {@link mailerFailing} as well, and then
 * withheld, past-allowance and attempted all answer alike. The send is still
 * attempted first: `deliver` records `ok` on the first one that works, so the
 * route recovers on its own without a pre-flight check's blind spot. A
 * deployment whose state is a stale `failing` keeps refusing until some
 * admitted address heals it — uniformly, which is the property worth having.
 *
 * The magic-link route needs no hook: it awaits its own callback, so
 * {@link mailSendFailure} thrown from there is already the answer. It does
 * need the same `mailerFailing` check, in front of the gate, for the same
 * reason.
 *
 * **This depends on `advanced.backgroundTasks.handler` staying unset.** With
 * one configured, `runInBackgroundOrAwait` stops awaiting the callback, the
 * send outruns the hook, and the 503 silently becomes a 200 again. This repo
 * sets no such handler.
 */
export function reportMailSendFailure(mail: MailStateReader): BetterAuthPlugin {
  return {
    id: 'mail-send-failure',
    hooks: {
      after: [
        {
          matcher: (context) => context.path === EMAIL_CODE_SEND_PATH,
          handler: createAuthMiddleware(async (context) => {
            if (mailSendFailed(context) || mailerFailing(mail)) {
              throw mailSendFailure('code');
            }
          }),
        },
      ],
    },
  };
}
