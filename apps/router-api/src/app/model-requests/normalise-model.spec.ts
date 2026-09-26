import { describe, expect, it } from 'vitest';
import { normaliseModelName } from './normalise-model.js';

describe('normaliseModelName', () => {
  it('merges the three ways a Hugging Face id is copied', () => {
    const expected = 'meta-llama/llama-3.3-70b-instruct';

    expect(normaliseModelName('meta-llama/Llama-3.3-70B-Instruct')).toBe(expected);
    expect(normaliseModelName('https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct')).toBe(expected);
    expect(normaliseModelName('hf.co/meta-llama/Llama-3.3-70B-Instruct')).toBe(expected);
    // Pasted from a chat client, which wraps a URL in angle brackets.
    expect(normaliseModelName('<https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct>')).toBe(expected);
    expect(normaliseModelName('"https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct/"')).toBe(expected);
  });

  it('collapses the differences that are typing rather than meaning', () => {
    expect(normaliseModelName('  Qwen2.5   72B  ')).toBe('qwen2.5 72b');
    expect(normaliseModelName('"deepseek-v3"')).toBe('deepseek-v3');
    expect(normaliseModelName('mistral-large/')).toBe('mistral-large');
    expect(normaliseModelName('gpt\u200b-oss-120b')).toBe('gpt-oss-120b');
  });

  it('keeps a quantisation or revision suffix apart — it names a different artefact', () => {
    expect(normaliseModelName('Llama-3.3-70B-Instruct-AWQ')).not.toBe(normaliseModelName('Llama-3.3-70B-Instruct'));
    expect(normaliseModelName('qwen3:4bit')).toBe('qwen3:4bit');
  });

  it('never groups a real ask under an empty key', () => {
    // Nothing but punctuation: stripping it would leave '' and an export row
    // nobody can act on, so the trimmed original stands.
    expect(normaliseModelName('  "" ')).toBe('""');
  });
});
