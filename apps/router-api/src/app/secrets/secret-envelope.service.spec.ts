import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SECRETS_KEY_ENV } from './secret-envelope.js';
import { SecretEnvelopeService } from './secret-envelope.service.js';

const PLAINTEXT = 'sk-upstream-0123456789abcdefghijklmnopqrstuvwxyz';
const CONTEXT = 'ext-endpoint-1';

/** A fresh service per case: the data key is read once and cached. */
function serviceWith(keyValue: string | undefined): SecretEnvelopeService {
  if (keyValue === undefined) {
    vi.stubEnv(SECRETS_KEY_ENV, undefined);
  } else {
    vi.stubEnv(SECRETS_KEY_ENV, keyValue);
  }
  return new SecretEnvelopeService();
}

/**
 * The services keep their `Logger` private, and what reaches a log line is part
 * of what these tests are about. One cast, named, instead of a bracket access at
 * every call site.
 */
function loggerOf(service: object): Logger {
  return (service as unknown as { logger: Logger }).logger;
}

/** Collects what the service logs at `level`, in order. */
function capture(service: object, level: 'log' | 'warn' | 'error'): string[] {
  const lines: string[] = [];
  // Nest's `Logger` methods take `(message, ...optionalParams)`, so the mock has
  // to as well; only the message is what these tests read.
  vi.spyOn(loggerOf(service), level).mockImplementation((message: unknown, ..._rest: unknown[]): void => {
    lines.push(String(message));
  });
  return lines;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('available', () => {
  it('is true with a usable key', () => {
    expect(serviceWith(randomBytes(32).toString('base64url')).available()).toBe(true);
  });

  it('is false with no key, and does not throw — the feature is optional', () => {
    // A deployment with no external endpoints needs no data key, so a missing one
    // is a refusal at registration rather than a boot failure.
    expect(serviceWith(undefined).available()).toBe(false);
  });

  it('is false with a malformed key, and names the problem in the log', () => {
    const service = serviceWith('not-thirty-two-bytes');
    const logged = capture(service, 'error');

    expect(service.available()).toBe(false);
    expect(logged.join('\n')).toContain(SECRETS_KEY_ENV);
    // The encoding, never the value.
    expect(logged.join('\n')).not.toContain('not-thirty-two-bytes');
  });
});

describe('seal / open', () => {
  it('returns a ciphertext and a display prefix, and reads the credential back', () => {
    const service = serviceWith(randomBytes(32).toString('base64url'));

    const sealed = service.seal(PLAINTEXT, CONTEXT);

    expect(sealed.ciphertext).not.toContain(PLAINTEXT);
    expect(PLAINTEXT.startsWith(sealed.prefix)).toBe(true);
    expect(service.open(sealed.ciphertext, CONTEXT)).toBe(PLAINTEXT);
  });

  it('refuses to seal without a key, naming the variable to set', () => {
    const service = serviceWith(undefined);

    expect(() => service.seal(PLAINTEXT, CONTEXT)).toThrow(new RegExp(SECRETS_KEY_ENV));
  });

  it('treats a rotation as a new write rather than an edit', () => {
    // There is no `rotate`: a new key is sealed over the old one, which is what
    // makes "the API never returns it" survivable — nothing has to read the old
    // value in order to replace it.
    const service = serviceWith(randomBytes(32).toString('base64url'));
    const first = service.seal(PLAINTEXT, CONTEXT);
    const second = service.seal('sk-upstream-rotated-value', CONTEXT);

    expect(service.open(second.ciphertext, CONTEXT)).toBe('sk-upstream-rotated-value');
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });
});

describe('the service itself', () => {
  it('does not reveal the data key however it is serialised', () => {
    const keyValue = randomBytes(32).toString('base64url');
    const service = serviceWith(keyValue);
    service.seal(PLAINTEXT, CONTEXT);

    for (const rendered of [JSON.stringify(service), inspect(service), String(service.toJSON())]) {
      expect(rendered).not.toContain(keyValue);
      // The decoded bytes must not surface either — `inspect` of a Buffer field
      // prints them as hex.
      expect(rendered).not.toContain(Buffer.from(keyValue, 'base64url').toString('hex'));
    }
  });

  it('says at boot whether storing an upstream key is possible, and never the key', () => {
    const keyValue = randomBytes(32).toString('base64url');
    const service = serviceWith(keyValue);
    const logged = capture(service, 'log');

    service.onApplicationBootstrap();

    expect(logged.join('\n')).toContain('a data key is configured');
    expect(logged.join('\n')).not.toContain(keyValue);
  });

  it('says at boot when the key is absent, so the refusal is not a surprise later', () => {
    const service = serviceWith(undefined);
    const logged = capture(service, 'log');

    service.onApplicationBootstrap();

    expect(logged.join('\n')).toContain(SECRETS_KEY_ENV);
    expect(logged.join('\n')).toContain('will be refused');
  });
});
