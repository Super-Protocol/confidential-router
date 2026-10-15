import { describe, expect, it } from 'vitest';
import { GATEKEEPER_BASE_URL, PLACEHOLDER_KEY, PLACEHOLDER_MODEL, SNIPPET_LANGUAGES, wiringSnippet } from './snippets';

describe('wiringSnippet', () => {
  it('points every client at the local gatekeeper by default', () => {
    for (const language of SNIPPET_LANGUAGES) {
      expect(wiringSnippet(language.id)).toContain(GATEKEEPER_BASE_URL);
    }
  });

  it('carries the placeholder when no key is available to show', () => {
    expect(wiringSnippet('python')).toContain(PLACEHOLDER_KEY);
  });

  it('never stands in a plausible model id for one it does not have', () => {
    // SUP-153: the default used to be the docs' example id. It reads as runnable
    // and answers 404, so a caller with no catalogue must show a visible blank.
    expect(PLACEHOLDER_MODEL).not.toMatch(/^[a-z0-9]+\/[a-z0-9.-]+:[a-z]+$/);
    for (const language of SNIPPET_LANGUAGES) {
      expect(wiringSnippet(language.id)).toContain(PLACEHOLDER_MODEL);
    }
  });

  it('uses the key and model it is given, verbatim', () => {
    const options = { apiKey: 'sk-tee-v1-4f7a', model: 'meta/llama-3.3-70b-instruct:tdx' };

    expect(wiringSnippet('node', options)).toContain("apiKey: 'sk-tee-v1-4f7a'");
    expect(wiringSnippet('python', options)).toContain('api_key="sk-tee-v1-4f7a"');
    expect(wiringSnippet('curl', options)).toContain('Authorization: Bearer sk-tee-v1-4f7a');
    for (const language of SNIPPET_LANGUAGES) {
      expect(wiringSnippet(language.id, options)).toContain('meta/llama-3.3-70b-instruct:tdx');
    }
  });

  it('sends curl valid JSON — the body is pasted into a shell as written', () => {
    const snippet = wiringSnippet('curl', { model: 'gpt-oss:tdx' });
    const body = snippet.slice(snippet.indexOf("-d '") + 4, snippet.lastIndexOf("'"));

    expect(JSON.parse(body)).toEqual({ model: 'gpt-oss:tdx', messages: [{ role: 'user', content: 'Hello' }] });
  });

  it('honours a base URL other than the default listen address', () => {
    expect(wiringSnippet('node', { baseUrl: 'http://127.0.0.1:9000/v1' })).toContain('http://127.0.0.1:9000/v1');
  });

  // SUP-255: two more clients, both configured by a file rather than a call, so
  // what matters is that the file parses and names the gatekeeper where each
  // tool looks for it.
  it('writes VS Code a Custom Endpoint entry with the full chat-completions URL', () => {
    const parsed = JSON.parse(wiringSnippet('vscode', { apiKey: 'sk-tee-v1-4f7a', model: 'gpt-oss:tdx' }));

    expect(parsed).toEqual([
      {
        name: 'Confidential Router',
        vendor: 'customendpoint',
        apiKey: 'sk-tee-v1-4f7a',
        models: [
          {
            id: 'gpt-oss:tdx',
            name: 'gpt-oss:tdx',
            url: `${GATEKEEPER_BASE_URL}/chat/completions`,
            toolCalling: true,
            vision: false,
          },
        ],
      },
    ]);
  });

  it('writes OpenCode an openai-compatible provider block keyed by the model id', () => {
    const parsed = JSON.parse(wiringSnippet('opencode', { apiKey: 'sk-tee-v1-4f7a', model: 'gpt-oss:tdx' }));

    expect(parsed.provider['confidential-router']).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'Confidential Router',
      options: { baseURL: GATEKEEPER_BASE_URL, apiKey: 'sk-tee-v1-4f7a' },
      models: { 'gpt-oss:tdx': { name: 'gpt-oss:tdx' } },
    });
  });

  it('tells the reader where each file-shaped snippet goes', () => {
    for (const id of ['vscode', 'opencode'] as const) {
      expect(SNIPPET_LANGUAGES.find((language) => language.id === id)?.hint).toBeTruthy();
    }
  });
});
