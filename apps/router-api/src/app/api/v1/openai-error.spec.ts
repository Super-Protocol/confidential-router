import { describe, expect, it } from 'vitest';
import { openAiErrors } from './openai-error.js';

/**
 * SUP-326: a bad key is not a model outage, and the message has to say so on
 * its own. A client may reach the router through a hop that drops the status —
 * VS Code's agent host re-stamps a BYOK failure as 502 — and then the message
 * is the only part of the refusal the user ever reads.
 */
describe('authentication refusals', () => {
  const refusals = [
    ['invalid_api_key', openAiErrors.missingApiKey()],
    ['invalid_api_key', openAiErrors.invalidApiKey()],
    ['api_key_placeholder', openAiErrors.apiKeyPlaceholder()],
    ['api_key_revoked', openAiErrors.apiKeyRevoked()],
    ['api_key_expired', openAiErrors.apiKeyExpired()],
  ] as const;

  it.each(refusals)('%s is a 401 that says nothing was sent to a model', (code, error) => {
    expect(error.status).toBe(401);
    expect(error.type).toBe('authentication_error');
    expect(error.code).toBe(code);
    expect(error.message).toMatch(/never reached a model/);
  });

  it('gives each cause its own wording', () => {
    const messages = refusals.map(([, error]) => error.message);

    expect(new Set(messages).size).toBe(messages.length);
    expect(openAiErrors.apiKeyRevoked().message).toMatch(/revoked/);
    expect(openAiErrors.apiKeyExpired().message).toMatch(/expired/);
    expect(openAiErrors.apiKeyPlaceholder().message).toMatch(/placeholder, not an API key/);
  });

  /**
   * The case a config file produces, and the one the whole change is for: a
   * credential that never arrived must not be reported as a key that failed.
   */
  it('says that nothing was presented when nothing was, without blaming a key', () => {
    const missing = openAiErrors.missingApiKey().message;

    expect(missing).toMatch(/^No API key was provided/);
    expect(missing).toMatch(/resolved to nothing/);
    expect(missing).not.toMatch(/incorrect|no such key/i);
    // Same code: a caller branching on it is asking one question.
    expect(openAiErrors.missingApiKey().code).toBe(openAiErrors.invalidApiKey().code);
  });

  it('points a dead key at a new key rather than at a retry', () => {
    for (const error of [openAiErrors.apiKeyRevoked(), openAiErrors.apiKeyExpired()]) {
      expect(error.message).toMatch(/create a new key/i);
    }
  });

  /**
   * The message the user was shown quoted the same `sk-tee-v1-…` that sat in
   * their config file as the key, so it read as a formatting example and their
   * own value looked right (SUP-326).
   */
  it('never quotes the placeholder as the example of a key', () => {
    for (const [, error] of refusals) {
      expect(error.message).not.toContain('sk-tee-v1-…');
    }
  });
});
