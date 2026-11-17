import { describe, expect, it } from 'vitest';
import { requestedModelSlug, resultOf, UNPARSEABLE_SLUG } from './model-demand.js';
import { openAiErrors } from './openai-error.js';

/**
 * What `model_requested` is allowed to say about a request — SUP-542.
 *
 * Two rules, and both are about what must *not* get out. `model_slug` is the one
 * property in the taxonomy whose value a caller supplies, so its bound is the
 * interesting behaviour, not its happy path. And `result` has to agree with the
 * status code the caller received, because a chart that disagrees with the API is
 * a chart nobody can use as evidence.
 */

describe('the model a request asked for', () => {
  it('reports the ids clients actually send, lower-cased and trimmed', () => {
    // Every one of these is a real spelling from the ecosystem: a namespaced
    // slug, a dated one, an Ollama-style tag, a dotted version.
    expect(requestedModelSlug({ model: 'qwen/qwen3-coder-next' })).toBe('qwen/qwen3-coder-next');
    expect(requestedModelSlug({ model: 'openai/gpt-4o-2024-11-20' })).toBe('openai/gpt-4o-2024-11-20');
    expect(requestedModelSlug({ model: 'llama3.3:70b' })).toBe('llama3.3:70b');
    expect(requestedModelSlug({ model: 'claude_sonnet_4_5' })).toBe('claude_sonnet_4_5');
    expect(requestedModelSlug({ model: '  GPT-4O  ' })).toBe('gpt-4o');
  });

  it('files prose as one row rather than giving it a row of its own', () => {
    // The cardinality bound convention 2 asks for, on a field we do not control.
    expect(requestedModelSlug({ model: 'the model I want, please' })).toBe(UNPARSEABLE_SLUG);
    expect(requestedModelSlug({ model: 'Summarise the attached contract' })).toBe(UNPARSEABLE_SLUG);
    expect(requestedModelSlug({ model: '-leading-dash' })).toBe(UNPARSEABLE_SLUG);
    expect(requestedModelSlug({ model: 'trailing-dash-' })).toBe(UNPARSEABLE_SLUG);
  });

  it('caps the value before judging its shape, so a long one cannot pass as an id', () => {
    // 65 lowercase letters has an identifier's shape and is not one. Truncating
    // first would have made it one.
    expect(requestedModelSlug({ model: 'a'.repeat(65) })).toBe(UNPARSEABLE_SLUG);
    expect(requestedModelSlug({ model: 'a'.repeat(64) })).toBe('a'.repeat(64));
  });

  it('says nothing at all when the request named no model', () => {
    // A client bug, with no demand in it to record. An event here would be a row
    // that says nothing about which models people want.
    expect(requestedModelSlug({})).toBeNull();
    expect(requestedModelSlug({ model: '' })).toBeNull();
    expect(requestedModelSlug({ model: '   ' })).toBeNull();
    expect(requestedModelSlug({ model: 42 })).toBeNull();
    expect(requestedModelSlug({ model: { id: 'gpt-4o' } })).toBeNull();
  });

  it('reads the model field and nothing else', () => {
    // The privacy rule, as a property of the function rather than a convention:
    // the prompt is in the body it was handed and is not in what came out.
    const slug = requestedModelSlug({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'my salary is 120000' }],
      system: 'You are a helpful assistant',
    });

    expect(slug).toBe('gpt-4o');
  });
});

describe('what the router decided', () => {
  it('maps each model refusal onto the answer the caller was given', () => {
    expect(resultOf(openAiErrors.modelNotFound('gpt-5'))).toBe('unknown_model');
    expect(resultOf(openAiErrors.modelNotInKeyScope('gpt-4o'))).toBe('out_of_key_scope');
    expect(resultOf(openAiErrors.attestationFailed('no verdict'))).toBe('not_verified');
    expect(resultOf(openAiErrors.unsupportedParameter('model', 'does not serve embeddings'))).toBe('unsupported_route');
  });

  it('refuses to file a request-shape refusal as demand for a model', () => {
    // `n > 1` shares the `unsupported_parameter` code with the route refusal and
    // says nothing about the model. Filing it as `unsupported_route` would put a
    // phantom gap in the catalogue report.
    expect(resultOf(openAiErrors.unsupportedParameter('n', 'only n = 1 is supported'))).toBeNull();
    expect(resultOf(openAiErrors.missingField('model'))).toBeNull();
    expect(resultOf(openAiErrors.invalidJson())).toBeNull();
    expect(resultOf(new Error('something else entirely'))).toBeNull();
  });
});
