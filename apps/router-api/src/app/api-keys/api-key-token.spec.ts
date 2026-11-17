import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_DISPLAY_PREFIX_LENGTH,
  API_KEY_PREFIX,
  bearerTokenOf,
  displayPrefixOf,
  hashApiKey,
  isCredentialPlaceholder,
  looksLikeApiKey,
  mintApiKey,
} from './api-key-token.js';

describe('mintApiKey', () => {
  it('produces the format the contract publishes', () => {
    const { secret } = mintApiKey();

    expect(secret.startsWith(API_KEY_PREFIX)).toBe(true);
    // 32 bytes of entropy, base64url — 43 characters with no padding.
    expect(secret.slice(API_KEY_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats', () => {
    const secrets = new Set(Array.from({ length: 500 }, () => mintApiKey().secret));

    expect(secrets.size).toBe(500);
  });

  it('returns only the hash and the display prefix for storage', () => {
    const { secret, keyHash, prefix } = mintApiKey();

    expect(keyHash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(keyHash).toHaveLength(64);
    expect(prefix).toBe(secret.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH));
    expect(keyHash).not.toContain(secret.slice(API_KEY_PREFIX.length));
  });

  it('leaves a display prefix that identifies the key without narrowing the search', () => {
    const { secret, prefix } = mintApiKey();

    // 12 characters of which 10 are the fixed scheme: two characters of secret.
    expect(prefix).toHaveLength(12);
    expect(displayPrefixOf(secret)).toBe(prefix);
    expect(secret.length - prefix.length).toBe(41);
  });
});

describe('hashApiKey', () => {
  it('is stable and depends on every character', () => {
    expect(hashApiKey('sk-tee-v1-abc')).toBe(hashApiKey('sk-tee-v1-abc'));
    expect(hashApiKey('sk-tee-v1-abc')).not.toBe(hashApiKey('sk-tee-v1-abd'));
  });
});

describe('looksLikeApiKey', () => {
  it('accepts a minted key', () => {
    expect(looksLikeApiKey(mintApiKey().secret)).toBe(true);
  });

  it.each([
    ['the wrong scheme', 'sk-cr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['too short', `${API_KEY_PREFIX}tooshort`],
    ['non base64url characters', `${API_KEY_PREFIX}${'+'.repeat(43)}`],
    ['empty', ''],
    ['a session cookie', 'better-auth.session_token=abc'],
  ])('rejects %s', (_case, value) => {
    expect(looksLikeApiKey(value)).toBe(false);
  });
});

/**
 * SUP-326: the strings that arrive as credentials having never been keys —
 * chiefly the `sk-tee-v1-…` a pasted command carries before its key is
 * replaced. A client that forwards a `${…}` reference verbatim lands here too;
 * the two IDEs we document do not, they send nothing at all.
 */
describe('isCredentialPlaceholder', () => {
  it.each([
    ['the docs placeholder', 'sk-tee-v1-…'],
    ["the console's masked prefix", 'sk-tee-v1-4f…'],
    ['an ASCII ellipsis', 'sk-tee-v1-...'],
    ['an unresolved input reference', '${input:routerKey}'],
    ['an unresolved env reference', '{env:ROUTER_KEY}'],
  ])('recognises %s', (_case, value) => {
    expect(isCredentialPlaceholder(value)).toBe(true);
  });

  it.each([
    ['a minted key', mintApiKey().secret],
    ['a wrong but plausible key', `${API_KEY_PREFIX}${'a'.repeat(43)}`],
    ['a key from another vendor', 'sk-proj-abcdef'],
    ['an ellipsis in the middle rather than the end', 'sk-tee-v1-…abc'],
    ['empty', ''],
  ])('leaves %s to the lookup', (_case, value) => {
    expect(isCredentialPlaceholder(value)).toBe(false);
  });
});

describe('bearerTokenOf', () => {
  it('reads a bearer token, case-insensitively', () => {
    expect(bearerTokenOf('Bearer sk-tee-v1-abc')).toBe('sk-tee-v1-abc');
    expect(bearerTokenOf('bearer  sk-tee-v1-abc  ')).toBe('sk-tee-v1-abc');
  });

  it.each([undefined, '', 'sk-tee-v1-abc', 'Basic dXNlcjpwYXNz', 'Bearer'])('refuses %s', (header) => {
    expect(bearerTokenOf(header)).toBeNull();
  });
});
