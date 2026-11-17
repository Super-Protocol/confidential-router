import { describe, expect, it } from 'vitest';
import { chatBodyForPrompt, textCompletionChunkOf, textCompletionOf } from './completions-bridge.js';
import { OpenAiApiError } from './openai-error.js';

function refusal(call: () => unknown): OpenAiApiError {
  try {
    call();
  } catch (error) {
    if (error instanceof OpenAiApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected an OpenAiApiError.');
}

describe('chatBodyForPrompt', () => {
  it('wraps the prompt in one user message and keeps everything else', () => {
    const body = chatBodyForPrompt({
      model: 'vendor/model',
      prompt: 'def add(a, b):',
      max_tokens: 64,
      temperature: 0,
      stop: ['\n\n'],
      stream: true,
      // A field this router has never heard of travels on, as on every route.
      guided_regex: '[0-9]+',
    });

    expect(body).toEqual({
      model: 'vendor/model',
      messages: [{ role: 'user', content: 'def add(a, b):' }],
      max_tokens: 64,
      temperature: 0,
      stop: ['\n\n'],
      stream: true,
      guided_regex: '[0-9]+',
    });
    expect(body).not.toHaveProperty('prompt');
  });

  it('takes a single-element array as the same request written differently', () => {
    expect(chatBodyForPrompt({ prompt: ['only one'] }).messages).toEqual([{ role: 'user', content: 'only one' }]);
  });

  it('keeps an empty prompt, which is a request and not an omission', () => {
    expect(chatBodyForPrompt({ prompt: '' }).messages).toEqual([{ role: 'user', content: '' }]);
  });

  it('refuses a batch of prompts', () => {
    const error = refusal(() => chatBodyForPrompt({ prompt: ['one', 'two'] }));

    expect(error.code).toBe('unsupported_parameter');
    expect(error.param).toBe('prompt');
  });

  it('refuses a pre-tokenised prompt rather than inventing text for it', () => {
    const error = refusal(() => chatBodyForPrompt({ prompt: [1045, 2003] }));

    expect(error.param).toBe('prompt');
    expect(error.message).toContain('token ids');
  });

  it('reports a missing prompt as a missing field', () => {
    const error = refusal(() => chatBodyForPrompt({ model: 'vendor/model' }));

    expect(error.code).toBe('missing_field');
    expect(error.param).toBe('prompt');
  });

  /*
   * The silent-drop alternative is the dangerous one: an autocomplete client
   * sends the text after the cursor as `suffix`, and an answer that ignored it
   * would be prose pasted into the middle of somebody's file.
   */
  it('refuses an infilling request by name', () => {
    const error = refusal(() => chatBodyForPrompt({ prompt: 'head', suffix: 'tail' }));

    expect(error.code).toBe('unsupported_parameter');
    expect(error.param).toBe('suffix');
    expect(error.message).toContain('completions');
  });

  it('refuses echo, logprobs and best_of when they are actually asked for', () => {
    expect(refusal(() => chatBodyForPrompt({ prompt: 'x', echo: true })).param).toBe('echo');
    expect(refusal(() => chatBodyForPrompt({ prompt: 'x', logprobs: 5 })).param).toBe('logprobs');
    expect(refusal(() => chatBodyForPrompt({ prompt: 'x', best_of: 4 })).param).toBe('best_of');
  });

  /*
   * Accepted *and* dropped. Forwarding them would hand the chat route a body
   * three of whose keys do not exist there and one of which has a different
   * type, which only a lenient upstream accepts — and `suffix: ''` is what an
   * autocomplete client sends with the cursor at end of file, so a strict
   * upstream answering 400 would land on the path this bridge exists to fix.
   */
  it('accepts their do-nothing values and leaves none of them in the body', () => {
    const body = chatBodyForPrompt({
      model: 'vendor/model',
      prompt: 'x',
      echo: false,
      logprobs: null,
      best_of: 1,
      suffix: '',
      temperature: 0.2,
    });

    expect(body).toEqual({
      model: 'vendor/model',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.2,
    });
    for (const param of ['suffix', 'echo', 'logprobs', 'best_of', 'prompt']) {
      expect(body).not.toHaveProperty(param);
    }
  });
});

describe('textCompletionOf', () => {
  it('turns a chat completion into a legacy one, identity and usage intact', () => {
    const translated = textCompletionOf({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1_756_550_000,
      model: 'upstream/model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'a + b' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });

    expect(translated).toEqual({
      id: 'chatcmpl-1',
      object: 'text_completion',
      created: 1_756_550_000,
      model: 'upstream/model',
      choices: [{ index: 0, text: 'a + b', logprobs: null, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
  });

  it('gives a tool-call turn empty text rather than dropping the choice', () => {
    // A legacy client cannot use `tool_calls`, but a choice that vanished would
    // break the envelope it validates.
    const translated = textCompletionOf({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
          finish_reason: 'tool_calls',
        },
      ],
    });

    expect(translated.choices).toEqual([{ index: 0, text: '', logprobs: null, finish_reason: 'tool_calls' }]);
  });

  it('survives a body with no choices at all', () => {
    expect(textCompletionOf({ id: 'x' })).toEqual({ id: 'x', object: 'text_completion', choices: [] });
  });
});

describe('textCompletionChunkOf', () => {
  it('turns a content delta into legacy text', () => {
    const translated = textCompletionChunkOf({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      model: 'upstream/model',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    });

    expect(translated).toEqual({
      id: 'chatcmpl-1',
      object: 'text_completion',
      model: 'upstream/model',
      choices: [{ index: 0, text: 'Hello', logprobs: null, finish_reason: null }],
    });
  });

  it('keeps a usage-only chunk recognisable as one', () => {
    // `choices: []` is how the relay spots the chunk the router asked for on its
    // own behalf; translating it into anything else would forward it to a client
    // that never wanted it.
    const translated = textCompletionChunkOf({
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });

    expect(translated.choices).toEqual([]);
    expect(translated.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2 });
  });

  it('turns the role-only opener into an empty delta, not into output', () => {
    const translated = textCompletionChunkOf({
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });

    expect(translated.choices).toEqual([{ index: 0, text: '', logprobs: null, finish_reason: null }]);
  });
});
