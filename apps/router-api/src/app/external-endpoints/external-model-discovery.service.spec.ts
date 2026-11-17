import { describe, expect, it } from 'vitest';
import { MAX_DISCOVERED_MODELS, parseModelList } from './external-model-discovery.service.js';

describe('parseModelList', () => {
  it('reads an OpenAI list, taking the hints a router and a vLLM publish', () => {
    expect(
      parseModelList({
        object: 'list',
        data: [
          {
            id: 'meta/llama',
            name: ' Llama ',
            context_length: 8192,
            pricing: { prompt_per_1m_micros: '400000', completion_per_1m_micros: 800000 },
          },
          { id: 'qwen', max_model_len: 32768 },
        ],
      }),
    ).toEqual([
      {
        upstreamModel: 'meta/llama',
        name: 'Llama',
        contextLength: 8192,
        promptPer1mMicros: 400000,
        completionPer1mMicros: 800000,
      },
      { upstreamModel: 'qwen', name: null, contextLength: 32768, promptPer1mMicros: null, completionPer1mMicros: null },
    ]);
  });

  it('drops blanks, duplicates and nonsense hints rather than failing the whole list', () => {
    expect(
      parseModelList({
        data: [{ id: '' }, { id: 'a', context_length: -1, pricing: { prompt_per_1m_micros: 'free' } }, { id: 'a' }, 7],
      }),
    ).toEqual([
      { upstreamModel: 'a', name: null, contextLength: null, promptPer1mMicros: null, completionPer1mMicros: null },
    ]);
  });

  it('is null for something that is not a model list at all', () => {
    expect(parseModelList({ error: 'nope' })).toBeNull();
    expect(parseModelList(null)).toBeNull();
  });

  it('caps the answer, which comes from another operator', () => {
    const data = Array.from({ length: MAX_DISCOVERED_MODELS + 5 }, (_, index) => ({ id: `m-${index}` }));
    expect(parseModelList({ data })).toHaveLength(MAX_DISCOVERED_MODELS);
  });
});
