import { describe, expect, it } from 'vitest';
import type { GatewayContext } from './gateway.types.js';
import { deltaTextOf, finishReasonOf, readUsage, shapeResponse } from './response-shaping.js';

const context = {
  generationId: 'gen-01J6TEST',
  model: { id: 'meta/llama-3.3-70b-instruct:tdx', endpoint: { name: 'llama-33-70b' } },
} as GatewayContext;

const extension = { costMicros: 5_450, endpoint: 'llama-33-70b', evidenceDigest: 'sha256/abc' };

describe('readUsage', () => {
  it('reads the OpenAI usage block', () => {
    expect(readUsage({ usage: { prompt_tokens: 11, completion_tokens: 7 } })).toEqual({
      promptTokens: 11,
      completionTokens: 7,
    });
  });

  it('treats a half-reported block as zero on the missing side', () => {
    expect(readUsage({ usage: { prompt_tokens: 11 } })).toEqual({ promptTokens: 11, completionTokens: 0 });
  });

  it('is null when the backend reported nothing usable', () => {
    expect(readUsage({})).toBeNull();
    expect(readUsage({ usage: null })).toBeNull();
    expect(readUsage({ usage: { total_tokens: 18 } })).toBeNull();
    expect(readUsage({ usage: { prompt_tokens: 'many' } })).toBeNull();
  });
});

describe('deltaTextOf', () => {
  it('reads streaming deltas, non-streaming messages and legacy text', () => {
    expect(deltaTextOf({ choices: [{ delta: { content: 'Hel' } }] })).toBe('Hel');
    expect(deltaTextOf({ choices: [{ message: { content: 'Hello' } }] })).toBe('Hello');
    expect(deltaTextOf({ choices: [{ text: 'Hello' }] })).toBe('Hello');
  });

  it('is empty for a chunk with no text — a role opener or a tool call', () => {
    expect(deltaTextOf({ choices: [{ delta: { role: 'assistant' } }] })).toBe('');
    expect(deltaTextOf({ choices: [] })).toBe('');
    expect(deltaTextOf({})).toBe('');
  });
});

describe('finishReasonOf', () => {
  it('reads the first reason present, and null while the stream runs', () => {
    expect(finishReasonOf({ choices: [{ finish_reason: 'stop' }] })).toBe('stop');
    expect(finishReasonOf({ choices: [{ finish_reason: null }] })).toBeNull();
    expect(finishReasonOf({})).toBeNull();
  });
});

describe('shapeResponse', () => {
  it('replaces the backend identity with the router s', () => {
    const shaped = shapeResponse({ id: 'chatcmpl-upstream', model: 'vllm/llama-3.3-70b' }, context, null);

    expect(shaped.id).toBe('gen-01J6TEST');
    expect(shaped.model).toBe('meta/llama-3.3-70b-instruct:tdx');
  });

  it('does not invent fields the backend did not send', () => {
    const shaped = shapeResponse({ object: 'list' }, context, null);

    expect(shaped).toEqual({ object: 'list' });
  });

  it('puts the extension fields inside usage, where OpenAI SDKs ignore them', () => {
    const shaped = shapeResponse({ usage: { prompt_tokens: 11, completion_tokens: 7 } }, context, extension);

    expect(shaped.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      cost_micros: 5_450,
      endpoint: 'llama-33-70b',
      evidence_digest: 'sha256/abc',
    });
  });

  it('keeps a total the backend reported rather than recomputing it', () => {
    const shaped = shapeResponse(
      { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 20 } },
      context,
      extension,
    );

    expect((shaped.usage as { total_tokens: number }).total_tokens).toBe(20);
  });

  it('records the absence of evidence as null, never as a verdict', () => {
    const shaped = shapeResponse({ usage: { prompt_tokens: 1, completion_tokens: 1 } }, context, {
      ...extension,
      evidenceDigest: null,
    });

    expect((shaped.usage as { evidence_digest: unknown }).evidence_digest).toBeNull();
    expect(JSON.stringify(shaped)).not.toMatch(/verified|valid|trusted/i);
  });

  it('leaves choices untouched', () => {
    const choices = [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }];
    const shaped = shapeResponse({ id: 'x', choices }, context, null);

    expect(shaped.choices).toEqual(choices);
  });
});
