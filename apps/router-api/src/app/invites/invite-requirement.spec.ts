import { describe, expect, it } from 'vitest';
import { SIGN_UP_REFUSAL_MESSAGES, type SignUpRefusalReason, signUpRefusalCodeOf } from './invite-requirement.js';

/**
 * The mapping is the whole contract with the console, and its interesting half is
 * what it *merges*: everything but "the code is spent" has to come out as one
 * value, or an anonymous caller can tell a real code from a guess by reading the
 * refusal.
 */
describe('the refusal a sign-up is turned away with', () => {
  it('has its own code for a request that carried no invitation', () => {
    expect(signUpRefusalCodeOf('missing')).toBe('invite_required');
  });

  it('says "already claimed" only for a code whose seats are gone', () => {
    expect(signUpRefusalCodeOf('exhausted')).toBe('invite_already_claimed');
  });

  it('gives one answer for never-issued, expired and withdrawn alike', () => {
    for (const reason of ['not_found', 'expired', 'disabled'] satisfies SignUpRefusalReason[]) {
      expect(signUpRefusalCodeOf(reason), reason).toBe('invite_expired_or_unknown');
    }
  });

  it('has a sentence for every code, because a client without our copy reads this one', () => {
    for (const reason of ['missing', 'not_found', 'expired', 'disabled', 'exhausted'] satisfies SignUpRefusalReason[]) {
      expect(SIGN_UP_REFUSAL_MESSAGES[signUpRefusalCodeOf(reason)], reason).toMatch(/\S/);
    }
  });

  it('says something different for each, which is the point of having three', () => {
    const sentences = Object.values(SIGN_UP_REFUSAL_MESSAGES);
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});
