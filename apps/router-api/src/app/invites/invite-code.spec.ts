import { describe, expect, it } from 'vitest';
import {
  formatInviteCode,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  inviteUrl,
  looksLikeInviteCode,
  mintInviteCode,
  normaliseInviteCode,
} from './invite-code.js';

describe('the alphabet', () => {
  it('contains no confusable pair', () => {
    for (const confusable of ['0', 'O', '1', 'I', 'L']) {
      expect(INVITE_CODE_ALPHABET).not.toContain(confusable);
    }
  });

  it('has no repeated character, so every code has the entropy the length implies', () => {
    expect(new Set(INVITE_CODE_ALPHABET).size).toBe(INVITE_CODE_ALPHABET.length);
  });
});

describe('mintInviteCode', () => {
  it('draws only from the alphabet, at the declared length', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const code = mintInviteCode();
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      expect([...code].every((character) => INVITE_CODE_ALPHABET.includes(character))).toBe(true);
    }
  });

  it('does not repeat itself over a campaign-sized sample', () => {
    const codes = new Set(Array.from({ length: 5_000 }, () => mintInviteCode()));

    expect(codes.size).toBe(5_000);
  });

  it('uses the whole alphabet rather than a biased slice', () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      for (const character of mintInviteCode()) {
        seen.add(character);
      }
    }

    expect(seen.size).toBe(INVITE_CODE_ALPHABET.length);
  });
});

describe('normaliseInviteCode', () => {
  it('folds case, so the URL a mail client rewrote still resolves', () => {
    expect(normaliseInviteCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
  });

  it('drops the separators a human or a line-wrap introduced', () => {
    expect(normaliseInviteCode(' ABCD EFGH_JKMN ')).toBe('ABCDEFGHJKMN');
    expect(normaliseInviteCode('ABCD--EFGH--JKMN')).toBe('ABCDEFGHJKMN');
  });

  it('is idempotent, so a stored code normalises to itself', () => {
    const code = mintInviteCode();

    expect(normaliseInviteCode(code)).toBe(code);
  });
});

describe('looksLikeInviteCode', () => {
  it('accepts a minted code', () => {
    expect(looksLikeInviteCode(mintInviteCode())).toBe(true);
  });

  it('refuses the wrong length', () => {
    expect(looksLikeInviteCode('ABCDEFGHJKM')).toBe(false);
    expect(looksLikeInviteCode('ABCDEFGHJKMNP')).toBe(false);
  });

  it('refuses a character outside the alphabet — including the excluded lookalikes', () => {
    expect(looksLikeInviteCode('ABCDEFGHJKM0')).toBe(false);
    expect(looksLikeInviteCode('ABCDEFGHJKMO')).toBe(false);
    expect(looksLikeInviteCode('ABCDEFGHJKM1')).toBe(false);
    expect(looksLikeInviteCode('abcdefghjkmn')).toBe(false);
  });
});

describe('formatInviteCode', () => {
  it('groups in fours, which is what an invitation shows', () => {
    expect(formatInviteCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
  });

  it('round-trips through normalisation', () => {
    const code = mintInviteCode();

    expect(normaliseInviteCode(formatInviteCode(code))).toBe(code);
  });
});

describe('inviteUrl', () => {
  const url = inviteUrl({
    landingBaseUrl: 'https://router.superprotocol.com',
    campaign: 'launch-2026-10-devs',
    code: 'ABCDEFGHJKMN',
  });

  it('points at the landing page with the code in the query', () => {
    expect(new URL(url).origin).toBe('https://router.superprotocol.com');
    expect(new URL(url).searchParams.get('invite')).toBe('ABCD-EFGH-JKMN');
  });

  it('carries the campaign as utm_campaign, which is the whole attribution story', () => {
    expect(new URL(url).searchParams.get('utm_campaign')).toBe('launch-2026-10-devs');
    expect(new URL(url).searchParams.get('utm_source')).toBe('email');
    expect(new URL(url).searchParams.get('utm_medium')).toBe('invite');
  });

  it('keeps a base URL that already has a path', () => {
    const nested = inviteUrl({
      landingBaseUrl: 'https://example.test/router/',
      campaign: 'c',
      code: 'ABCDEFGHJKMN',
    });

    expect(new URL(nested).pathname).toBe('/router/');
  });
});
