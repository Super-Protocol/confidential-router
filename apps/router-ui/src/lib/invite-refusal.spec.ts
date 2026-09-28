import { describe, expect, it } from 'vitest';
import { INVITE_REFUSAL_COPY, inviteRefusalOf, isInviteRefusalCode } from './invite-refusal';

/**
 * The reader of `?error=`, which is a parameter the console does not own: Better
 * Auth puts its own failures through it, and an attacker can put anything at all
 * in it. So the interesting half of this is what it refuses to recognise.
 */
describe('reading a refusal off the URL', () => {
  it('recognises the three the router can answer a sign-up with', () => {
    expect(inviteRefusalOf('?error=invite_required')).toBe('invite_required');
    expect(inviteRefusalOf('?error=invite_already_claimed')).toBe('invite_already_claimed');
    expect(inviteRefusalOf('?error=invite_expired_or_unknown')).toBe('invite_expired_or_unknown');
  });

  it('ignores Better Auth’s own errors, which are not about invitations', () => {
    for (const search of ['?error=INVALID_TOKEN', '?error=state_not_found', '?error=access_denied']) {
      expect(inviteRefusalOf(search), search).toBeNull();
    }
  });

  it('ignores anything else a URL can carry', () => {
    for (const search of ['', '?invite=ABCD-EFGH-JKLM', '?error=', '?error=<script>alert(1)</script>']) {
      expect(inviteRefusalOf(search), search).toBeNull();
    }
  });

  it('has copy for every code it recognises, and a different sentence for each', () => {
    const codes = ['invite_required', 'invite_already_claimed', 'invite_expired_or_unknown'];
    const titles = codes.map((code) => {
      expect(isInviteRefusalCode(code)).toBe(true);
      return INVITE_REFUSAL_COPY[code as keyof typeof INVITE_REFUSAL_COPY].title;
    });

    expect(new Set(titles).size).toBe(codes.length);
  });
});
