import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact', () => {
  it('masks values of sensitive keys at any depth', () => {
    expect(redact({ auth: { clientSecret: 's3cret', clientId: 'public' }, apiKey: 'sk-tee-v1-abc' })).toEqual({
      auth: { clientSecret: '[REDACTED]', clientId: 'public' },
      apiKey: '[REDACTED]',
    });
  });

  it('matches key names case-insensitively and as substrings', () => {
    expect(redact({ Authorization: 'Bearer x', sessionToken: 'y' })).toEqual({
      Authorization: '[REDACTED]',
      sessionToken: '[REDACTED]',
    });
  });

  it('walks arrays', () => {
    expect(redact({ keys: [{ token: 'a' }, { token: 'b' }] })).toEqual({
      keys: [{ token: '[REDACTED]' }, { token: '[REDACTED]' }],
    });
  });

  it('survives a circular reference', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(redact(node)).toEqual({ name: 'root', self: '[CIRCULAR]' });
  });

  it('honours a custom key list', () => {
    expect(redact({ token: 'keep', custom: 'hide' }, ['custom'])).toEqual({ token: 'keep', custom: '[REDACTED]' });
  });
});
