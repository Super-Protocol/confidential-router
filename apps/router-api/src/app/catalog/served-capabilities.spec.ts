import { describe, expect, it } from 'vitest';
import { bridgesCompletions, servedCapabilities, servesRoute } from './served-capabilities.js';

describe('servedCapabilities', () => {
  it('reports the legacy route, streaming and tool calling for a chat-only model', () => {
    // The production registration, which used to be listed as `["chat"]` while
    // the same model streamed tool calls all day and answered 400 on
    // /v1/completions (SUP-450).
    expect(servedCapabilities(['chat'])).toEqual(['chat', 'completions', 'tools', 'streaming']);
  });

  it('is the same list whether the legacy route is declared or derived', () => {
    // Declaring `completions` changes how the route is served — forwarded rather
    // than translated — and not what the catalogue promises.
    expect(servedCapabilities(['chat', 'completions'])).toEqual(servedCapabilities(['chat']));
  });

  it('claims no chat and no tools for a legacy-only model', () => {
    expect(servedCapabilities(['completions'])).toEqual(['completions', 'streaming']);
  });

  it('claims nothing but embeddings for an embeddings model', () => {
    // Not streaming: the gateway never streams that route — it answers one
    // JSON body whatever the client asked for — so claiming it here would be the
    // catalogue lying in the other direction. It does not *refuse* `stream: true`
    // there, it ignores it (`gateway.service.ts`, `kind !== 'embeddings'`), which
    // is pre-existing behaviour this list only has to describe honestly.
    expect(servedCapabilities(['embeddings'])).toEqual(['embeddings']);
  });

  it('is canonically ordered, whatever order the config used', () => {
    expect(servedCapabilities(['embeddings', 'completions', 'chat'])).toEqual([
      'chat',
      'completions',
      'embeddings',
      'tools',
      'streaming',
    ]);
  });

  it('serves nothing for a model that declares nothing', () => {
    expect(servedCapabilities([])).toEqual([]);
  });
});

describe('servesRoute', () => {
  it('admits the legacy route for a chat-only model', () => {
    expect(servesRoute(['chat'], 'completions')).toBe(true);
  });

  it('refuses a route the model has nothing to do with', () => {
    expect(servesRoute(['chat'], 'embeddings')).toBe(false);
    expect(servesRoute(['embeddings'], 'chat')).toBe(false);
    expect(servesRoute(['embeddings'], 'completions')).toBe(false);
  });

  it('agrees with the list it is reported from, for every route', () => {
    // The invariant the conformance test checks over HTTP, here over every
    // declarable combination: the gate and the catalogue read one function.
    for (const declared of [['chat'], ['completions'], ['embeddings'], ['chat', 'completions'], []] as const) {
      for (const route of ['chat', 'completions', 'embeddings'] as const) {
        expect(servesRoute(declared, route)).toBe(servedCapabilities(declared).includes(route));
      }
    }
  });
});

describe('bridgesCompletions', () => {
  it('translates only for a model that has chat and not the legacy route', () => {
    expect(bridgesCompletions(['chat'])).toBe(true);
    expect(bridgesCompletions(['chat', 'completions'])).toBe(false);
    expect(bridgesCompletions(['completions'])).toBe(false);
    expect(bridgesCompletions(['embeddings'])).toBe(false);
  });
});
