import { describe, expect, it } from 'vitest';
import { estimatePromptTokens, estimateTokens } from './token-estimator.js';

describe('estimateTokens', () => {
  it('is zero for empty and whitespace-only text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   \n\t ')).toBe(0);
  });

  it('grows with the text', () => {
    const short = estimateTokens('Hello');
    const long = estimateTokens('Hello '.repeat(100));

    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short * 50);
  });

  it('lands within a factor of two of the four-characters-per-token rule', () => {
    const text = 'The quick brown fox jumps over the lazy dog, repeatedly and without complaint.';
    const rough = text.length / 4;

    expect(estimateTokens(text)).toBeGreaterThan(rough / 2);
    expect(estimateTokens(text)).toBeLessThan(rough * 2);
  });
});

describe('estimatePromptTokens', () => {
  it('reads chat messages, including their per-message overhead', () => {
    const single = estimatePromptTokens({ messages: [{ role: 'user', content: 'Hello' }] });
    const double = estimatePromptTokens({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'user', content: 'Hello' },
      ],
    });

    expect(single).toBeGreaterThan(0);
    expect(double).toBe(single * 2);
  });

  it('reads multi-part content and ignores parts with no text', () => {
    const parts = estimatePromptTokens({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
          ],
        },
      ],
    });

    expect(parts).toBe(estimatePromptTokens({ messages: [{ role: 'user', content: 'Describe this' }] }));
  });

  it('reads the legacy completions prompt and the embeddings input', () => {
    expect(estimatePromptTokens({ prompt: 'Once upon a time' })).toBeGreaterThan(0);
    expect(estimatePromptTokens({ input: ['alpha', 'beta'] })).toBeGreaterThan(0);
  });

  it('is zero for a body with nothing countable in it', () => {
    expect(estimatePromptTokens({ model: 'meta/llama:tdx', temperature: 0.2 })).toBe(0);
  });
});
