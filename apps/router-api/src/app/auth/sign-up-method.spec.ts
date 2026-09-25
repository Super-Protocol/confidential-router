import { describe, expect, it } from 'vitest';
import { signUpMethodOf } from './sign-up-method.js';

describe('signUpMethodOf', () => {
  it('reads the password path', () => {
    expect(signUpMethodOf({ path: '/sign-up/email' })).toBe('password');
  });

  it('reads a magic-link verification', () => {
    expect(signUpMethodOf({ path: '/magic-link/verify' })).toBe('magic_link');
  });

  it('reads the provider out of an OAuth callback', () => {
    expect(signUpMethodOf({ path: '/callback/github' })).toBe('github');
    expect(signUpMethodOf({ path: '/callback/google' })).toBe('google');
  });

  it('matches a callback mounted under a longer prefix', () => {
    // Better Auth has moved the callback between `/callback/:id` and
    // `/oauth2/callback/:id`; the provider is the part that matters.
    expect(signUpMethodOf({ path: '/oauth2/callback/github' })).toBe('github');
  });

  it('calls the bootstrap admin a password account', () => {
    // The taxonomy has four values and no fifth. The bootstrap account is the
    // operator's own and never a campaign sign-up.
    expect(signUpMethodOf({ path: '/bootstrap' })).toBe('password');
  });

  it('answers for a context with no path at all', () => {
    expect(signUpMethodOf(null)).toBe('password');
    expect(signUpMethodOf({})).toBe('password');
  });
});
