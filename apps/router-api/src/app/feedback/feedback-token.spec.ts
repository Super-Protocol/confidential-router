import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueFeedbackToken, verifyFeedbackToken } from './feedback-token.js';

/**
 * The token is the only thing standing between a public form and the ledger, so
 * every way of getting one wrong is asserted here rather than left to the
 * webhook's integration test.
 */

const SECRET = 'feedback-token-secret-'.padEnd(48, 'x');
const TTL = 30 * 60 * 1000;
const NOW = new Date('2026-09-25T12:00:00Z');

function issue(overrides: Partial<{ userId: string; workspaceId: string; issuedAt: number }> = {}): string {
  return issueFeedbackToken(SECRET, {
    userId: 'user-1',
    workspaceId: 'ws-1',
    issuedAt: NOW.getTime(),
    ...overrides,
  });
}

describe('issuing', () => {
  it('round-trips the claims it was given', () => {
    expect(verifyFeedbackToken(SECRET, issue(), { ttlMs: TTL, now: NOW })).toEqual({
      valid: true,
      claims: { userId: 'user-1', workspaceId: 'ws-1', issuedAt: NOW.getTime() },
    });
  });

  it('is URL-safe, because it rides in the form link as a query parameter', () => {
    expect(issue()).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it('produces a different token per account', () => {
    expect(issue({ userId: 'user-2' })).not.toEqual(issue());
  });
});

describe('verifying', () => {
  it('refuses a token signed with another deployment’s secret', () => {
    const foreign = issueFeedbackToken('another-deployments-secret-'.padEnd(48, 'y'), {
      userId: 'user-1',
      workspaceId: 'ws-1',
      issuedAt: NOW.getTime(),
    });

    expect(verifyFeedbackToken(SECRET, foreign, { ttlMs: TTL, now: NOW })).toEqual({
      valid: false,
      failure: 'bad_signature',
    });
  });

  it('refuses a token whose claims were edited to name someone else', () => {
    const [, signature] = issue().split('.');
    const forged = `${Buffer.from('v1:victim:ws-1:' + NOW.getTime(), 'utf8').toString('base64url')}.${signature}`;

    expect(verifyFeedbackToken(SECRET, forged, { ttlMs: TTL, now: NOW })).toEqual({
      valid: false,
      failure: 'bad_signature',
    });
  });

  it.each([
    ['', 'empty'],
    ['nonsense', 'unstructured'],
    ['a.b.c', 'three parts'],
    ['.sig', 'no payload'],
  ])('refuses %s input (%s)', (token) => {
    expect(verifyFeedbackToken(SECRET, token, { ttlMs: TTL, now: NOW }).valid).toBe(false);
  });

  it('accepts a token up to the last millisecond of its life', () => {
    const token = issue();
    const atExpiry = new Date(NOW.getTime() + TTL);

    expect(verifyFeedbackToken(SECRET, token, { ttlMs: TTL, now: atExpiry }).valid).toBe(true);
    expect(verifyFeedbackToken(SECRET, token, { ttlMs: TTL, now: new Date(atExpiry.getTime() + 1) })).toEqual({
      valid: false,
      failure: 'expired',
    });
  });

  it('refuses a token minted in the future, which means a clock moved', () => {
    const token = issue({ issuedAt: NOW.getTime() + 60_000 });

    expect(verifyFeedbackToken(SECRET, token, { ttlMs: TTL, now: NOW })).toEqual({
      valid: false,
      failure: 'expired',
    });
  });

  it('refuses a correctly signed payload whose shape is not the one we issue', () => {
    // Signed with the deployment's own key, so this is not a forgery — it is an
    // old or future token format. The verifier still has to refuse it: accepting
    // one would mean accepting whatever that other format allowed.
    for (const payload of [`v0:user-1:ws-1:${NOW.getTime()}`, 'v1:user-1:ws-1:not-a-number', 'v1::ws-1:0']) {
      expect(verifyFeedbackToken(SECRET, sign(payload), { ttlMs: TTL, now: NOW })).toEqual({
        valid: false,
        failure: 'malformed',
      });
    }
  });
});

/**
 * A token over an arbitrary payload, mirroring the implementation's key
 * derivation on purpose: these assertions are about what a *validly signed*
 * token is still refused for, which cannot be shown without being able to sign
 * one.
 */
function sign(payload: string): string {
  const key = createHmac('sha256', SECRET).update('feedback-form-token').digest();
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`;
}
