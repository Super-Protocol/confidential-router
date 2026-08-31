import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_PATH, bootstrapAdmin, secretsMatch } from './bootstrap-admin.plugin.js';

const TOKEN = 'bootstrap-token-32-characters-ok';

describe('secretsMatch', () => {
  it('accepts the token it was given', () => {
    expect(secretsMatch(TOKEN, TOKEN)).toBe(true);
  });

  it('rejects a different token of the same length', () => {
    expect(secretsMatch(`${TOKEN.slice(0, -1)}X`, TOKEN)).toBe(false);
  });

  it('rejects a shorter and a longer token without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, and a thrown-versus-
    // returned difference is itself an oracle for the token's length.
    expect(secretsMatch('', TOKEN)).toBe(false);
    expect(secretsMatch(TOKEN.slice(0, 4), TOKEN)).toBe(false);
    expect(secretsMatch(`${TOKEN}-and-more`, TOKEN)).toBe(false);
  });

  it('rejects a prefix of the token, which a byte-by-byte compare would not', () => {
    expect(secretsMatch(TOKEN.slice(0, TOKEN.length - 1), TOKEN)).toBe(false);
  });
});

describe('bootstrapAdmin', () => {
  const plugin = bootstrapAdmin({ token: TOKEN, email: 'admin@example.test' });

  it('mounts one endpoint, under the auth base path', () => {
    expect(BOOTSTRAP_PATH).toBe('/bootstrap');
    expect(Object.keys(plugin.endpoints ?? {})).toEqual(['bootstrapAdmin']);
  });

  it('rate-limits its own path and nothing else', () => {
    const rule = plugin.rateLimit?.find((candidate) => candidate.pathMatcher(BOOTSTRAP_PATH));

    expect(rule).toBeDefined();
    expect(rule?.max).toBe(5);
    expect(plugin.rateLimit?.some((candidate) => candidate.pathMatcher('/sign-in/magic-link'))).toBe(false);
  });

  it('keeps the token out of everything it exposes', () => {
    expect(JSON.stringify(plugin.endpoints?.bootstrapAdmin.options ?? {})).not.toContain(TOKEN);
  });
});
