import { describe, expect, it, vi } from 'vitest';
import { INVITE_COOKIE_NAME } from '../invites/sign-up-invite.js';
import { EMAIL_CODE_SEND_PATH } from '../mail/email-code-throttle.js';
import {
  MAGIC_LINK_SEND_PATH,
  type MailGateContext,
  mayMailSignUp,
  signUpMailGate,
} from './sign-up-mail-gate.plugin.js';

/**
 * Whether a send route may send, on its own.
 *
 * The decision is the interesting half — which requests are a sign-up, and
 * which of those carry an invitation — and it answers a true or a false rather
 * than a response, so it can be asked without a Better Auth instance. What the
 * routes do with the answer, and that a refusal is indistinguishable from a
 * send, is `email-code.e2e.spec.ts`.
 */

const CODE = 'ABCD-EFGH-JKMN';
const EMAIL = 'someone@example.com';

function headers(entries: Record<string, string> = {}) {
  const lower = new Map(Object.entries(entries).map(([name, value]) => [name.toLowerCase(), value]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/** A hook context for an address the `user` table knows, or does not. */
function context(overrides: Partial<MailGateContext> & { account?: boolean } = {}): MailGateContext {
  const { account = false, ...rest } = overrides;
  return {
    headers: headers(),
    context: { internalAdapter: { findUserByEmail: async () => (account ? { user: { email: EMAIL } } : null) } },
    ...rest,
  };
}

/** A gate that admits only `CODE`, and records what it was asked about. */
function admitting(code: string | null = CODE) {
  return vi.fn(async (invite: { code: string | null }) => invite.code === code);
}

describe('mailing a sign-up', () => {
  it('goes ahead for an address that already has an account, invitation or not', async () => {
    const admits = admitting();

    await expect(mayMailSignUp(context({ account: true, body: { email: EMAIL } }), admits)).resolves.toBe(true);
    // Not even asked: the invitation requirement is about accounts coming into
    // existence, and this one exists.
    expect(admits).not.toHaveBeenCalled();
  });

  it('goes ahead for an unknown address that carries a usable invitation', async () => {
    const body = { email: EMAIL, type: 'sign-in', inviteCode: CODE };

    await expect(mayMailSignUp(context({ body }), admitting())).resolves.toBe(true);
  });

  it('stops for an unknown address with no invitation at all', async () => {
    await expect(mayMailSignUp(context({ body: { email: EMAIL, type: 'sign-in' } }), admitting())).resolves.toBe(false);
  });

  it('stops for an unknown address whose invitation the gate refuses', async () => {
    const body = { email: EMAIL, type: 'sign-in', inviteCode: 'WXYZ-WXYZ-WXYZ' };

    await expect(mayMailSignUp(context({ body }), admitting())).resolves.toBe(false);
  });

  it('finds the invitation wherever the two send routes carry it', async () => {
    const admits = admitting();
    const inCallback = { email: EMAIL, callbackURL: `https://console.test/auth/callback?invite=${CODE}` };
    const inCookie = context({ body: { email: EMAIL }, headers: headers({ cookie: `${INVITE_COOKIE_NAME}=${CODE}` }) });

    await expect(mayMailSignUp(context({ body: inCallback }), admits)).resolves.toBe(true);
    await expect(mayMailSignUp(inCookie, admits)).resolves.toBe(true);
  });

  it('matches the address the way the table holds it, so case is not a way past the gate', async () => {
    const findUserByEmail = vi.fn(async () => null);
    const current = context({ body: { email: 'Someone@Example.COM ' } });
    current.context = { internalAdapter: { findUserByEmail } };

    await expect(mayMailSignUp(current, admitting())).resolves.toBe(false);
    expect(findUserByEmail).toHaveBeenCalledWith(EMAIL);
  });

  it('leaves a request with no address to the route’s own validation', async () => {
    const admits = admitting();

    await expect(mayMailSignUp(context({ body: { type: 'sign-in' } }), admits)).resolves.toBe(true);
    await expect(mayMailSignUp(context({ body: undefined }), admits)).resolves.toBe(true);
    expect(admits).not.toHaveBeenCalled();
  });
});

describe('the hooks it registers', () => {
  const hooks = () => signUpMailGate({ admits: admitting() }).hooks?.before ?? [];

  it('watches both routes that mail an address, and nothing else', () => {
    const paths = ['/sign-in/email-otp', '/sign-in/social', '/magic-link/verify', '/bootstrap'];
    const matched = (path: string, body: unknown) =>
      hooks().some((hook) => hook.matcher({ path, body } as Parameters<typeof hook.matcher>[0]));

    expect(matched(EMAIL_CODE_SEND_PATH, { email: EMAIL, type: 'sign-in' })).toBe(true);
    expect(matched(MAGIC_LINK_SEND_PATH, { email: EMAIL })).toBe(true);
    for (const path of paths) {
      expect(matched(path, { email: EMAIL }), path).toBe(false);
    }
  });

  it('leaves the code types this deployment does not mail alone', () => {
    const [emailCode] = hooks();

    for (const type of ['email-verification', 'forget-password', undefined]) {
      const matched = emailCode.matcher({ path: EMAIL_CODE_SEND_PATH, body: { email: EMAIL, type } } as Parameters<
        typeof emailCode.matcher
      >[0]);
      expect(matched, String(type)).toBe(false);
    }
  });
});
