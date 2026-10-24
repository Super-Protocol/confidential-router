import { describe, expect, it } from 'vitest';
import { EMAIL_CODE_SEND_PATH } from '../mail/email-code-throttle.js';
import {
  MAIL_SEND_FAILED,
  type MailSendContext,
  type MailStateReader,
  mailerFailing,
  mailSendFailed,
  mailSendFailure,
  recordMailSendFailure,
  reportMailSendFailure,
} from './mail-send-failure.plugin.js';

/**
 * The two halves of SUP-460 on their own: the mark a failed send leaves on the
 * request, and the refusal the after hook builds from it. That the mark
 * survives the one hop between Better Auth's `sendVerificationOTP` callback
 * and its after hook — the whole reason this exists — is `mail-smtp.e2e.spec.ts`,
 * against a port nothing is listening on.
 */

/** A request Better Auth would hand both the callback and the hook. */
function request(path = EMAIL_CODE_SEND_PATH): MailSendContext & { path: string } {
  return { path, context: {} };
}

/** A deployment whose mailer is in the given state. */
function mailer(state: ReturnType<MailStateReader['status']>['state']): MailStateReader {
  return { status: () => ({ state }) };
}

describe('the mark a failed send leaves', () => {
  it('is not there to begin with', () => {
    expect(mailSendFailed(request())).toBe(false);
  });

  it('is there once a send has failed, and only on that request', () => {
    const failed = request();
    const other = request();

    expect(recordMailSendFailure(failed)).toBe(true);

    expect(mailSendFailed(failed)).toBe(true);
    expect(mailSendFailed(other)).toBe(false);
  });

  it('cannot be left on a call that has no request, and says so', () => {
    expect(recordMailSendFailure(undefined)).toBe(false);
    expect(recordMailSendFailure(null)).toBe(false);
    expect(recordMailSendFailure({})).toBe(false);

    expect(mailSendFailed(undefined)).toBe(false);
    expect(mailSendFailed({})).toBe(false);
  });
});

describe('what the requester is told', () => {
  it('is a 503 under one name, whichever mail step it was', () => {
    for (const [what, sentence] of [
      ['code', 'The sign-in code could not be sent. Try again in a moment.'],
      ['link', 'The sign-in link could not be sent. Try again in a moment.'],
    ] as const) {
      const error = mailSendFailure(what);

      expect(error.statusCode).toBe(503);
      expect(error.body).toEqual({ code: MAIL_SEND_FAILED, message: sentence });
    }
  });

  it('names no host, account or provider', () => {
    const said = JSON.stringify([mailSendFailure('code').body, mailSendFailure('link').body]);

    expect(said).not.toMatch(/smtp|resend|@|:\d{2,5}\b/i);
  });
});

describe('whether the deployment can mail at all', () => {
  it('is only false while the last check or send worked, or none has run', () => {
    expect(mailerFailing(mailer('failing'))).toBe(true);
    for (const state of ['ok', 'unverified', 'disabled'] as const) {
      expect(mailerFailing(mailer(state)), state).toBe(false);
    }
  });
});

describe('the after hook', () => {
  const hookOf = (mail: MailStateReader) => reportMailSendFailure(mail).hooks?.after?.[0];
  const hook = hookOf(mailer('ok'));

  it('watches the send route and nothing else', () => {
    expect(hook?.matcher(request() as never)).toBe(true);
    expect(hook?.matcher(request('/sign-in/email-otp') as never)).toBe(false);
  });

  it('lets a request through when the code went out', async () => {
    await expect(hook?.handler(request() as never)).resolves.not.toThrow();
  });

  it('refuses one whose code did not', async () => {
    const failed = request();
    recordMailSendFailure(failed);

    await expect(hook?.handler(failed as never)).rejects.toMatchObject({
      statusCode: 503,
      body: { code: MAIL_SEND_FAILED },
    });
  });

  /**
   * The oracle this is built to avoid. On an invite-only deployment the gate
   * returns before the send for an uninvited address, so that request carries
   * no mark however broken the mailer is — and answering it 200 while an
   * account holder's request gets a 503 is account enumeration. The mailer's
   * own state is what both are answered from.
   */
  it('refuses an unmarked request too while the mailer is down', async () => {
    const withheld = request();

    await expect(hookOf(mailer('failing'))?.handler(withheld as never)).rejects.toMatchObject({
      statusCode: 503,
      body: { code: MAIL_SEND_FAILED },
    });
  });
});
