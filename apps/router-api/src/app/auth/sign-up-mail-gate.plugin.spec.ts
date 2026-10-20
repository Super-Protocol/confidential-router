import { describe, expect, it, vi } from 'vitest';
import { INVITE_COOKIE_NAME, INVITE_QUERY_PARAM } from '../invites/sign-up-invite.js';
import { EMAIL_CODE_SEND_PATH } from '../mail/email-code-throttle.js';
import {
  MAGIC_LINK_SEND_PATH,
  type MailGateContext,
  mayMailSignUp,
  signUpInviteCarrier,
} from './sign-up-mail-gate.plugin.js';

/**
 * Whether a mail step may send, on its own.
 *
 * The decision is the interesting half — which requests are a sign-up, and
 * which of those carry an invitation — and it answers a true or a false rather
 * than a response, so it can be asked without a Better Auth instance. That it
 * is asked at the mail callback, where no route or body shape can get past it,
 * and that a refusal is indistinguishable from a send, is
 * `email-code.e2e.spec.ts`.
 */

const CODE = 'ABCD-EFGH-JKMN';
const EMAIL = 'someone@example.com';

function headers(entries: Record<string, string> = {}) {
  const lower = new Map(Object.entries(entries).map(([name, value]) => [name.toLowerCase(), value]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/** An endpoint context for an address the `user` table knows, or does not. */
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

    await expect(mayMailSignUp(EMAIL, context({ account: true }), admits)).resolves.toBe(true);
    // Not even asked: the invitation requirement is about accounts coming into
    // existence, and this one exists.
    expect(admits).not.toHaveBeenCalled();
  });

  it('goes ahead for an unknown address whose request carries a usable invitation', async () => {
    const query = { [INVITE_QUERY_PARAM]: CODE };

    await expect(mayMailSignUp(EMAIL, context({ query }), admitting())).resolves.toBe(true);
  });

  it('stops for an unknown address with no invitation at all', async () => {
    await expect(mayMailSignUp(EMAIL, context(), admitting())).resolves.toBe(false);
  });

  it('stops for an unknown address whose invitation the gate refuses', async () => {
    const query = { [INVITE_QUERY_PARAM]: 'WXYZ-WXYZ-WXYZ' };

    await expect(mayMailSignUp(EMAIL, context({ query }), admitting())).resolves.toBe(false);
  });

  it('finds the invitation wherever the two mail steps carry it', async () => {
    const admits = admitting();
    const inCallback = { email: EMAIL, callbackURL: `https://console.test/auth/callback?invite=${CODE}` };
    const inCookie = context({ headers: headers({ cookie: `${INVITE_COOKIE_NAME}=${CODE}` }) });

    // The magic-link request keeps its `callbackURL`; the code route's body is
    // replaced by its schema, so the carrier below puts the code in the query.
    await expect(mayMailSignUp(EMAIL, context({ body: inCallback }), admits)).resolves.toBe(true);
    await expect(mayMailSignUp(EMAIL, inCookie, admits)).resolves.toBe(true);
  });

  it('matches the address the way the table holds it, so case is not a way past the gate', async () => {
    const findUserByEmail = vi.fn(async () => null);

    await expect(
      mayMailSignUp('Someone@Example.COM ', { context: { internalAdapter: { findUserByEmail } } }, admitting()),
    ).resolves.toBe(false);
    expect(findUserByEmail).toHaveBeenCalledWith(EMAIL);
  });

  it('refuses a send it has no request to judge, rather than letting it through', async () => {
    // Unreachable today — nothing calls the send endpoints from inside the
    // application — and fails closed if that ever changes.
    await expect(mayMailSignUp(EMAIL, undefined, admitting())).resolves.toBe(false);
    await expect(mayMailSignUp(EMAIL, {}, admitting())).resolves.toBe(false);
  });
});

/**
 * The carrier makes no decision, so what is worth pinning is that the code
 * arrives where the gate reads it — and that nothing it does can un-gate a
 * send, because a request it misses reaches the gate with no invitation.
 */
describe('carrying the invitation past the body schema', () => {
  const hook = () => {
    const hooks = signUpInviteCarrier().hooks?.before ?? [];
    expect(hooks).toHaveLength(1);
    return hooks[0];
  };

  type HookContext = Parameters<ReturnType<typeof hook>['matcher']>[0];

  /** As Better Auth's dispatcher calls it: `returnHeaders`, so the answer is wrapped. */
  function run(body: unknown, query: unknown = undefined) {
    return hook().handler({ path: EMAIL_CODE_SEND_PATH, body, query, returnHeaders: true } as HookContext) as Promise<{
      response?: unknown;
    }>;
  }

  it('moves an `inviteCode` out of the body and into the query', async () => {
    const answer = await run({ email: EMAIL, type: 'sign-in', inviteCode: CODE });

    expect(answer).toMatchObject({ response: { context: { query: { [INVITE_QUERY_PARAM]: CODE } } } });
  });

  it('keeps the rest of the query, and does not amend a request with no code on it', async () => {
    const carried = await run({ email: EMAIL, type: 'sign-in', inviteCode: CODE }, { other: 'kept' });

    expect(carried).toMatchObject({
      response: { context: { query: { other: 'kept', [INVITE_QUERY_PARAM]: CODE } } },
    });
    expect((await run({ email: EMAIL, type: 'sign-in' })).response).toBeUndefined();
  });

  it('watches the one route whose schema drops the code, and no other', () => {
    const matcher = hook().matcher;

    expect(matcher({ path: EMAIL_CODE_SEND_PATH } as HookContext)).toBe(true);
    for (const path of [MAGIC_LINK_SEND_PATH, '/sign-in/email-otp', '/sign-in/social', '/bootstrap']) {
      expect(matcher({ path } as HookContext), path).toBe(false);
    }
  });

  it('carries every type the route accepts, because it is not the thing that decides', async () => {
    for (const type of ['sign-in', 'email-verification', 'forget-password', undefined]) {
      const answer = await run({ email: EMAIL, type, inviteCode: CODE });

      expect(answer, String(type)).toMatchObject({
        response: { context: { query: { [INVITE_QUERY_PARAM]: CODE } } },
      });
    }
  });
});
