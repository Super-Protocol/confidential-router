/**
 * The drop-in wiring snippet, in the three shapes the screen offers.
 *
 * The whole point of the router's OpenAI-compatible surface is that adopting it
 * is *one base-URL swap* — so these are pure functions with no formatting state,
 * and a test can assert the exact line a user is asked to paste.
 */

/** The listen address `gatekeeper endpoint add` suggests, and the docs use. */
export const GATEKEEPER_LISTEN = '127.0.0.1:8787';

/** What the OpenAI SDK is pointed at once a gatekeeper fronts the endpoint. */
export const GATEKEEPER_BASE_URL = `http://${GATEKEEPER_LISTEN}/v1`;

/**
 * Stands in for a key the console can no longer read. Keys are shown in full
 * exactly once, so every snippet outside that one dialog carries a placeholder.
 */
export const PLACEHOLDER_KEY = 'sk-tee-v1-…';

export const PLACEHOLDER_MODEL = 'meta/llama-3.3-70b-instruct:tdx';

export interface SnippetOptions {
  /** Where the SDK points — the local gatekeeper, not the router. */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export type SnippetLanguage = 'curl' | 'python' | 'node';

interface ResolvedOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function resolve({ baseUrl, apiKey, model }: SnippetOptions): ResolvedOptions {
  return {
    baseUrl: baseUrl ?? GATEKEEPER_BASE_URL,
    apiKey: apiKey ?? PLACEHOLDER_KEY,
    model: model ?? PLACEHOLDER_MODEL,
  };
}

function curlSnippet(options: SnippetOptions): string {
  const { baseUrl, apiKey, model } = resolve(options);
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }] });
  return [
    `curl ${baseUrl}/chat/completions \\`,
    `  -H "Authorization: Bearer ${apiKey}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${body}'`,
  ].join('\n');
}

function pythonSnippet(options: SnippetOptions): string {
  const { baseUrl, apiKey, model } = resolve(options);
  return [
    'from openai import OpenAI',
    '',
    'client = OpenAI(',
    `    base_url="${baseUrl}",  # your local Gatekeeper`,
    `    api_key="${apiKey}",`,
    ')',
    '',
    'response = client.chat.completions.create(',
    `    model="${model}",`,
    '    messages=[{"role": "user", "content": "Hello"}],',
    ')',
    'print(response.choices[0].message.content)',
  ].join('\n');
}

function nodeSnippet(options: SnippetOptions): string {
  const { baseUrl, apiKey, model } = resolve(options);
  return [
    "import OpenAI from 'openai';",
    '',
    'const client = new OpenAI({',
    `  baseURL: '${baseUrl}', // your local Gatekeeper`,
    `  apiKey: '${apiKey}',`,
    '});',
    '',
    'const response = await client.chat.completions.create({',
    `  model: '${model}',`,
    "  messages: [{ role: 'user', content: 'Hello' }],",
    '});',
    'console.log(response.choices[0].message.content);',
  ].join('\n');
}

const BUILDERS: Record<SnippetLanguage, (options: SnippetOptions) => string> = {
  curl: curlSnippet,
  python: pythonSnippet,
  node: nodeSnippet,
};

export const SNIPPET_LANGUAGES: { id: SnippetLanguage; label: string }[] = [
  { id: 'curl', label: 'curl' },
  { id: 'python', label: 'Python' },
  { id: 'node', label: 'Node' },
];

export function wiringSnippet(language: SnippetLanguage, options: SnippetOptions = {}): string {
  return BUILDERS[language](options);
}
