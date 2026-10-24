import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT_KEYS, redact } from './redact.js';

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

  it('still sanitises content when the credential list is overridden', () => {
    expect(redact({ custom: 'hide', messages: [{ role: 'user', content: 'secret prompt' }] }, ['custom'])).toEqual({
      custom: '[REDACTED]',
      messages: '[CONTENT REDACTED]',
    });
  });
});

/**
 * The sanitiser `/privacy` §5 and §13 credit with stripping prompt and
 * completion content before a line is written (SUP-497).
 *
 * One test per field name rather than one test over the list: the point of the
 * list is that a reviewer can check a published sentence against it, and a loop
 * would pass just as happily over a list someone had emptied.
 */
describe('redact, on request and response content', () => {
  const CONTENT = '[CONTENT REDACTED]';

  it('drops a chat completions request body whole', () => {
    expect(
      redact({
        model: 'qwen/qwen3-coder-next',
        messages: [{ role: 'user', content: 'the text of my prompt' }],
        stream: true,
      }),
    ).toEqual({ model: 'qwen/qwen3-coder-next', messages: CONTENT, stream: true });
  });

  it('drops `messages`', () => {
    expect(redact({ messages: [{ role: 'user', content: 'hi' }] })).toEqual({ messages: CONTENT });
  });

  it('drops `prompt`', () => {
    expect(redact({ prompt: 'complete this' })).toEqual({ prompt: CONTENT });
  });

  it('drops `input`', () => {
    expect(redact({ input: ['embed this', 'and this'] })).toEqual({ input: CONTENT });
  });

  it('drops `content`', () => {
    expect(redact({ role: 'user', content: 'what I typed' })).toEqual({ role: 'user', content: CONTENT });
  });

  it('drops `choices`', () => {
    expect(redact({ choices: [{ index: 0, message: { content: 'the answer' } }] })).toEqual({ choices: CONTENT });
  });

  it('drops `delta`', () => {
    expect(redact({ index: 0, delta: { content: 'tok' } })).toEqual({ index: 0, delta: CONTENT });
  });

  it('drops `text`', () => {
    expect(redact({ text: 'a completion, or an upstream body quoting one' })).toEqual({ text: CONTENT });
  });

  it('drops `completion`', () => {
    expect(redact({ completion: 'what the model said' })).toEqual({ completion: CONTENT });
  });

  it('drops `embedding`', () => {
    expect(redact({ embedding: [0.1, 0.2] })).toEqual({ embedding: CONTENT });
  });

  it('drops content nested under any key, at any depth', () => {
    expect(redact({ req: { graphql: { variables: { content: 'a chat message' } } } })).toEqual({
      req: { graphql: { variables: { content: CONTENT } } },
    });
  });

  it('drops content case-insensitively', () => {
    expect(redact({ Messages: [], PROMPT: 'x' })).toEqual({ Messages: CONTENT, PROMPT: CONTENT });
  });

  it('matches content keys exactly, so the fields merely named after them survive', () => {
    // The reason the two lists have different matching rules. Substring
    // matching would take `contextLength` for `text`, `contentType` and
    // `contentLength` for `content`, and `promptVersion` for `prompt` — and the
    // first three are most of what an operational log is for. Redacting them
    // would be a reason to turn the sanitiser off.
    expect(
      redact({
        contextLength: 262144,
        contentType: 'application/json',
        contentLength: 410,
        promptVersion: 3,
        finishReason: 'stop',
      }),
    ).toEqual({
      contextLength: 262144,
      contentType: 'application/json',
      contentLength: 410,
      promptVersion: 3,
      finishReason: 'stop',
    });
  });

  it('leaves the token counts to the credential list, which already masks them', () => {
    // Not this change's doing and not this change's to undo: `token` is in
    // `DEFAULT_SENSITIVE_KEYS` and matches as a substring, so the counts have
    // read `[REDACTED]` since that list was written. Pinned here because the
    // test above would otherwise look like it was asserting the opposite.
    expect(redact({ promptTokens: 12, completionTokens: 34 })).toEqual({
      promptTokens: '[REDACTED]',
      completionTokens: '[REDACTED]',
    });
  });

  it('names every field the published pages rely on', () => {
    // `/privacy` §13 says request and response content, not some of it. This is
    // the row `docs/legal/traceability.md` in the landing repository points at,
    // so shrinking the list has to be a deliberate edit here.
    expect([...DEFAULT_CONTENT_KEYS].sort()).toEqual([
      'choices',
      'completion',
      'content',
      'delta',
      'embedding',
      'input',
      'messages',
      'prompt',
      'text',
    ]);
  });
});
