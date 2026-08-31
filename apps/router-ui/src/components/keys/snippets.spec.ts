import { describe, expect, it } from 'vitest';
import { GATEKEEPER_BASE_URL, PLACEHOLDER_KEY, SNIPPET_LANGUAGES, wiringSnippet } from './snippets';

describe('wiringSnippet', () => {
  it('points every client at the local gatekeeper by default', () => {
    for (const language of SNIPPET_LANGUAGES) {
      expect(wiringSnippet(language.id)).toContain(GATEKEEPER_BASE_URL);
    }
  });

  it('carries the placeholder when no key is available to show', () => {
    expect(wiringSnippet('python')).toContain(PLACEHOLDER_KEY);
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
});
