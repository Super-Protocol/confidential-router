import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { redact } from '@confidential-router/server-common';
import { describe, expect, it } from 'vitest';
import {
  MalformedSecretsKeyError,
  MissingSecretsKeyError,
  openSecret,
  parseSecretsKey,
  SECRET_DISPLAY_PREFIX_LENGTH,
  SECRETS_KEY_ENV,
  SecretDecryptionError,
  sealSecret,
  secretDisplayPrefix,
} from './secret-envelope.js';

/** A real upstream key's shape, so a leak in a message would be recognisable. */
const PLAINTEXT = 'sk-upstream-0123456789abcdefghijklmnopqrstuvwxyz';
const CONTEXT = 'ext-endpoint-1';

const key = randomBytes(32);
const otherKey = randomBytes(32);

describe('parseSecretsKey', () => {
  it('accepts base64url, base64 and hex spellings of the same 32 bytes', () => {
    const bytes = randomBytes(32);

    expect(parseSecretsKey(bytes.toString('base64url'))).toEqual(bytes);
    expect(parseSecretsKey(bytes.toString('base64'))).toEqual(bytes);
    expect(parseSecretsKey(bytes.toString('hex'))).toEqual(bytes);
  });

  it('ignores surrounding whitespace, which a Secret mounted as a file carries', () => {
    const bytes = randomBytes(32);

    expect(parseSecretsKey(`  ${bytes.toString('base64url')}\n`)).toEqual(bytes);
  });

  it('refuses a missing key by name, so an operator knows what to set', () => {
    for (const value of [undefined, '', '   ']) {
      expect(() => parseSecretsKey(value)).toThrow(MissingSecretsKeyError);
    }
    expect(() => parseSecretsKey(undefined)).toThrow(new RegExp(SECRETS_KEY_ENV));
  });

  it('refuses a key of the wrong length rather than padding it', () => {
    // Half a key is a copy-paste accident, and accepting it would encrypt real
    // credentials under 16 known-zero bytes.
    expect(() => parseSecretsKey(randomBytes(16).toString('base64url'))).toThrow(MalformedSecretsKeyError);
    expect(() => parseSecretsKey(randomBytes(48).toString('base64url'))).toThrow(MalformedSecretsKeyError);
  });

  it('never puts the key in the message of the error it throws about the key', () => {
    const value = randomBytes(16).toString('base64url');

    expect(() => parseSecretsKey(value)).toThrow(MalformedSecretsKeyError);
    try {
      parseSecretsKey(value);
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
      expect((error as Error).message).toContain('16 bytes');
    }
  });
});

describe('sealSecret / openSecret', () => {
  it('round-trips a credential', () => {
    expect(openSecret(key, sealSecret(key, PLAINTEXT, CONTEXT), CONTEXT)).toBe(PLAINTEXT);
  });

  it('never produces the plaintext, or a substring of it, in the envelope', () => {
    const envelope = sealSecret(key, PLAINTEXT, CONTEXT);

    expect(envelope).not.toContain(PLAINTEXT);
    // A stream cipher with a reused nonce would leak structure; GCM with a fresh
    // 96-bit nonce per write does not. Check the recognisable part specifically.
    expect(envelope).not.toContain('sk-upstream');
    expect(envelope).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
  });

  it('produces a different envelope every time, so equal keys are not detectable', () => {
    const first = sealSecret(key, PLAINTEXT, CONTEXT);
    const second = sealSecret(key, PLAINTEXT, CONTEXT);

    expect(first).not.toBe(second);
    expect(openSecret(key, first, CONTEXT)).toBe(openSecret(key, second, CONTEXT));
  });

  it('refuses a ciphertext moved to another endpoint’s row', () => {
    // The binding is what stops a database writer redirecting one upstream's
    // credential to a different upstream (ADR-008 §6).
    const envelope = sealSecret(key, PLAINTEXT, CONTEXT);

    expect(() => openSecret(key, envelope, 'ext-endpoint-2')).toThrow(SecretDecryptionError);
  });

  it('refuses the wrong key', () => {
    expect(() => openSecret(otherKey, sealSecret(key, PLAINTEXT, CONTEXT), CONTEXT)).toThrow(SecretDecryptionError);
  });

  it('refuses a tampered or truncated envelope', () => {
    const envelope = sealSecret(key, PLAINTEXT, CONTEXT);
    const payload = envelope.slice('v1.'.length);

    expect(() => openSecret(key, `v1.${payload.slice(0, -4)}`, CONTEXT)).toThrow(SecretDecryptionError);
    expect(() => openSecret(key, 'v1.AAAA', CONTEXT)).toThrow(SecretDecryptionError);
    expect(() => openSecret(key, `v2.${payload}`, CONTEXT)).toThrow(SecretDecryptionError);
    expect(() => openSecret(key, payload, CONTEXT)).toThrow(SecretDecryptionError);
  });

  it('says nothing about the bytes when it refuses', () => {
    // Every failure is the same message on purpose: with an AEAD, "wrong key",
    // "wrong binding" and "altered payload" are indistinguishable, and a message
    // that quoted the envelope would put a ciphertext in the log.
    const envelope = sealSecret(key, PLAINTEXT, CONTEXT);

    try {
      openSecret(otherKey, envelope, CONTEXT);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(envelope);
      expect(message).not.toContain(PLAINTEXT);
      expect(message).toContain('the key, the binding or the payload does not match');
    }
  });
});

describe('secretDisplayPrefix', () => {
  it('keeps only enough to tell two keys apart', () => {
    expect(secretDisplayPrefix(PLAINTEXT)).toBe(PLAINTEXT.slice(0, SECRET_DISPLAY_PREFIX_LENGTH));
    expect(secretDisplayPrefix(PLAINTEXT).length).toBeLessThan(PLAINTEXT.length / 4);
  });

  it('does not pad a short credential into something that looks longer', () => {
    expect(secretDisplayPrefix('short')).toBe('short');
  });
});

describe('what reaches a log line', () => {
  it('redacts a record carrying the sealed key and the prefix', () => {
    // `redact` runs over every structured log record (`server-common`), and the
    // column names were chosen so it catches them: both contain "apikey".
    const record = redact({
      endpoint: 'upstream-a',
      apiKeyCiphertext: sealSecret(key, PLAINTEXT, CONTEXT),
      apiKeyPrefix: secretDisplayPrefix(PLAINTEXT),
    }) as Record<string, string>;

    expect(record.apiKeyCiphertext).toBe('[REDACTED]');
    expect(record.apiKeyPrefix).toBe('[REDACTED]');
    expect(record.endpoint).toBe('upstream-a');
  });

  it('leaves no plaintext in a serialised envelope, however it is printed', () => {
    const envelope = sealSecret(key, PLAINTEXT, CONTEXT);

    for (const rendered of [String(envelope), JSON.stringify({ envelope }), inspect({ envelope })]) {
      expect(rendered).not.toContain(PLAINTEXT);
      expect(rendered).not.toContain('sk-upstream');
    }
  });
});
