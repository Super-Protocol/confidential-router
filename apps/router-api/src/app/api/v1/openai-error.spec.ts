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
    ['invalid_api_key', openAiErrors.invalidApiKey()],
    ['api_key_revoked', openAiErrors.apiKeyRevoked()],
    ['api_key_expired', openAiErrors.apiKeyExpired()],
  ] as const;

  it.each(refusals)('%s is a 401 that says nothing was sent to a model', (code, error) => {
    expect(error.status).toBe(401);
    expect(error.type).toBe('authentication_error');
    expect(error.code).toBe(code);
    expect(error.message).toMatch(/never reached a model/);
  });

  it('tells an unknown key apart from a revoked one in the human message', () => {
    const unknown = openAiErrors.invalidApiKey().message;
    const revoked = openAiErrors.apiKeyRevoked().message;

    expect(unknown).not.toBe(revoked);
    // The case the test group hits after an installation is rebuilt: the key
    // was real, and the router it was minted by is gone.
    expect(unknown).toMatch(/earlier installation/);
    expect(revoked).toMatch(/revoked/);
  });

  it('points every expired or revoked key at the console rather than at a retry', () => {
    for (const error of [openAiErrors.invalidApiKey(), openAiErrors.apiKeyRevoked(), openAiErrors.apiKeyExpired()]) {
      expect(error.message).toMatch(/issue a new one in the console/i);
    }
  });
});
