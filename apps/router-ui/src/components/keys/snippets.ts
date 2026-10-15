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
 *
 * Only the command-shaped snippets use it. A command is edited in the terminal
 * line the user is already typing; a *file* is pasted once and forgotten, and a
 * placeholder left in one is refused by the router as a bad key — or, with this
 * U+2026 in it, is not even sent: a Node or Electron client rejects the header
 * before the wire ("Invalid character in header content"). Hence
 * {@link VSCODE_KEY_REFERENCE} and {@link OPENCODE_KEY_REFERENCE} (SUP-326).
 */
export const PLACEHOLDER_KEY = 'sk-tee-v1-…';

/**
 * VS Code's own reference to a secret it stores rather than a literal in the
 * file: it prompts for the value once, keeps it in secret storage, and
 * substitutes it per request. It is what VS Code's documentation shows for
 * `apiKey`, so a pasted file is complete as it stands.
 */
export const VSCODE_KEY_REFERENCE = '${input:routerKey}';

/** OpenCode's equivalent: the key comes from `ROUTER_KEY` in the environment. */
export const OPENCODE_KEY_REFERENCE = '{env:ROUTER_KEY}';

/**
 * Stands in for a model id when the caller has no catalogue to hand — while
 * `models` is still in flight, or on a deployment that serves nothing yet.
 *
 * Deliberately not a plausible id. It used to be `meta/llama-3.3-70b-instruct:tdx`,
 * the example id the docs use, and the onboarding card shipped it to real
 * accounts as a snippet to copy: it looked runnable and answered
 * `404 model_not_found` (SUP-153). A visible blank is the honest failure — every
 * caller with a catalogue passes `model` and never sees this.
 */
export const PLACEHOLDER_MODEL = '<model-id>';

export interface SnippetOptions {
  /** Where the SDK points — the local gatekeeper, not the router. */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export type SnippetLanguage = 'curl' | 'python' | 'node' | 'vscode' | 'opencode';

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

/**
 * VS Code's chat, through its Custom Endpoint provider: one entry of
 * `chatLanguageModels.json`, which the model picker's gear icon ▸ Add Models ▸
 * Custom Endpoint opens. `url` is the full chat-completions address, not a base
 * URL — that is how the provider is specified.
 */
function vscodeSnippet(options: SnippetOptions): string {
  const { baseUrl, model } = resolve(options);
  return JSON.stringify(
    [
      {
        name: 'Confidential Router',
        vendor: 'customendpoint',
        // Deliberately not the caller's key: see VSCODE_KEY_REFERENCE.
        apiKey: VSCODE_KEY_REFERENCE,
        models: [{ id: model, name: model, url: `${baseUrl}/chat/completions`, toolCalling: true, vision: false }],
      },
    ],
    null,
    2,
  );
}

/**
 * OpenCode, as a provider block of `opencode.json` — in the project, or in
 * `~/.config/opencode/` for every project. `@ai-sdk/openai-compatible` is its
 * adapter for any `/v1/chat/completions` server, which the gatekeeper is.
 */
function opencodeSnippet(options: SnippetOptions): string {
  const { baseUrl, model } = resolve(options);
  return JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        'confidential-router': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Confidential Router',
          // Deliberately not the caller's key: see OPENCODE_KEY_REFERENCE.
          options: { baseURL: baseUrl, apiKey: OPENCODE_KEY_REFERENCE },
          models: { [model]: { name: model } },
        },
      },
    },
    null,
    2,
  );
}

const BUILDERS: Record<SnippetLanguage, (options: SnippetOptions) => string> = {
  curl: curlSnippet,
  python: pythonSnippet,
  node: nodeSnippet,
  vscode: vscodeSnippet,
  opencode: opencodeSnippet,
};

export interface SnippetLanguageEntry {
  id: SnippetLanguage;
  label: string;
  /** One line under the code: where the snippet goes, for the two that are files rather than commands. */
  hint?: string;
}

export const SNIPPET_LANGUAGES: SnippetLanguageEntry[] = [
  { id: 'curl', label: 'curl' },
  { id: 'python', label: 'Python' },
  { id: 'node', label: 'Node' },
  {
    id: 'vscode',
    label: 'VS Code',
    hint:
      'In the chat model picker open the gear icon ▸ Add Models ▸ Custom Endpoint, then paste this into the ' +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code's own `${input:…}` syntax, quoted for the reader.
      'chatLanguageModels.json it opens. VS Code asks for the key once and keeps it in secret storage; ${input:routerKey} stays in the file.',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    hint:
      'Save as opencode.json in your project, or in ~/.config/opencode/ for every project; "{env:ROUTER_KEY}" ' +
      'reads the key from the environment, so export it before you start. Then pick the model in OpenCode.',
  },
];

export function wiringSnippet(language: SnippetLanguage, options: SnippetOptions = {}): string {
  return BUILDERS[language](options);
}
