import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { signLink, verifyLink } from './signed-link.js';

const SECRET = 'signed-link-test-secret'.padEnd(48, 'x');
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

function mint(claims: Record<string, string | number> & { aud: string }, ttlMs = 60_000): string {
  return signLink(SECRET, claims, { ttlMs, now: NOW });
}

describe('verifyLink', () => {
  it('returns the claims of a link it signed', () => {
    const token = mint({ aud: 'evidence:export', workspaceId: 'ws-1' });

    expect(verifyLink(SECRET, token, { audience: 'evidence:export', now: NOW })).toMatchObject({
      workspaceId: 'ws-1',
      exp: NOW + 60_000,
    });
  });

  it('refuses a link signed with another secret', () => {
    const token = mint({ aud: 'evidence:export' });

    expect(() => verifyLink('a-different-secret'.padEnd(48, 'y'), token, { audience: 'evidence:export' })).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a link whose payload was edited', () => {
    const token = mint({ aud: 'evidence:export', workspaceId: 'ws-1' });
    const [, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ aud: 'evidence:export', workspaceId: 'ws-2', exp: NOW + 60_000 }),
    ).toString('base64url');

    expect(() => verifyLink(SECRET, `${forged}.${signature}`, { audience: 'evidence:export', now: NOW })).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a valid link presented to the wrong endpoint', () => {
    const token = mint({ aud: 'billing:manual-checkout' });

    expect(() => verifyLink(SECRET, token, { audience: 'evidence:export', now: NOW })).toThrow(UnauthorizedException);
  });

  it('refuses an expired link', () => {
    const token = mint({ aud: 'evidence:export' }, 1_000);

    expect(() => verifyLink(SECRET, token, { audience: 'evidence:export', now: NOW + 2_000 })).toThrow(/expired/);
  });

  it('refuses a malformed token instead of throwing something unhandled', () => {
    for (const token of ['', 'nonsense', 'a.b', `${Buffer.from('{').toString('base64url')}.x`]) {
      expect(() => verifyLink(SECRET, token, { audience: 'evidence:export' })).toThrow(UnauthorizedException);
    }
  });
});
