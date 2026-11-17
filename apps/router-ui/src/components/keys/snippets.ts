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
  /**
   * The model's context length from the catalogue. VS Code's language-models
   * entry uses it as `contextWindow`; without it the snippet names no token
   * limits rather than inventing a pair that can exceed the window.
   */
  contextLength?: number;
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
 * Completion cap written next to `contextWindow`. VS Code derives
 * `maxInputTokens` as the difference, and the sum of the two must not exceed
 * the model's context window, so the cap is also kept to half of a short window.
 */
const VSCODE_MAX_OUTPUT_TOKENS = 8_192;

/**
 * An example of the reference Update API Key writes. The id after
 * `chat.lm.secret.` is generated. A literal key is not a reference: resolution
 * yields an empty bearer.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code's own `${input:…}` syntax, not a template.
const VSCODE_API_KEY_INPUT = '${input:chat.lm.secret.-...}';

/**
 * VS Code's chat, through its Custom Endpoint provider: one entry of the
 * language-models JSON the Command Palette or the agent model picker opens.
 * `url` is the full chat-completions address, not a base URL — that is how the
 * provider is specified. The key is never written here; `options.apiKey` is for
 * the other clients.
 */
function vscodeSnippet(options: SnippetOptions): string {
  const { baseUrl, model } = resolve(options);
  const limits = vscodeLimits(options.contextLength);
  return JSON.stringify(
    [
      {
        name: 'Confidential Router',
        vendor: 'customendpoint',
        apiKey: VSCODE_API_KEY_INPUT,
        models: [
          {
            id: model,
            name: model,
            url: `${baseUrl}/chat/completions`,
            toolCalling: true,
            vision: false,
            ...limits,
          },
        ],
      },
    ],
    null,
    2,
  );
}

/**
 * `contextWindow` is the catalogue's context length. `maxOutputTokens` stays
 * inside it, so VS Code's derived input budget cannot overflow the window.
 * No catalogue means no numbers: a hardcoded pair would be a lie about a model
 * the snippet does not know.
 */
function vscodeLimits(
  contextLength: number | undefined,
): { contextWindow: number; maxOutputTokens: number } | undefined {
  if (contextLength === undefined || !Number.isInteger(contextLength) || contextLength < 1) return undefined;
  return {
    contextWindow: contextLength,
    maxOutputTokens: Math.max(1, Math.min(VSCODE_MAX_OUTPUT_TOKENS, Math.floor(contextLength / 2))),
  };
}

/**
 * OpenCode, as a provider block of `opencode.json` — in the project, or in
 * `~/.config/opencode/` for every project. `@ai-sdk/openai-compatible` is its
 * adapter for any `/v1/chat/completions` server, which the gatekeeper is.
 */
function opencodeSnippet(options: SnippetOptions): string {
  const { baseUrl, apiKey, model } = resolve(options);
  return JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        'confidential-router': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Confidential Router',
          options: { baseURL: baseUrl, apiKey },
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
  /**
   * Numbered ways to open the file the snippet is pasted into, when there is
   * more than one. The phrase "go-to-file icon" is where the console draws the
   * VS Code codicon of that name.
   */
  steps?: readonly string[];
}

export const SNIPPET_LANGUAGES: SnippetLanguageEntry[] = [
  { id: 'curl', label: 'curl' },
  { id: 'python', label: 'Python' },
  { id: 'node', label: 'Node' },
  {
    id: 'vscode',
    label: 'VS Code',
    steps: [
      'Press Ctrl+Shift+P (Windows/Linux) or Cmd+Shift+P (Mac), start typing Chat: Open Language Models (JSON), press Enter, and paste this block.',
      'In the agent chat, open the model selector, click +, then the go-to-file icon in the top right, and paste this block into the file that opens.',
    ],
    hint: 'Then click + in the model selector, open the gear on the Confidential Router group, choose Update API Key, paste the key, and press Enter. That writes the apiKey reference above; the id differs, so leave that line. Do not paste the key into the file.',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    hint:
      'Save as opencode.json in your project, or in ~/.config/opencode/ for every project; "{env:ROUTER_KEY}" in ' +
      'place of the key reads it from the environment instead. Then pick the model in OpenCode.',
  },
];

export function wiringSnippet(language: SnippetLanguage, options: SnippetOptions = {}): string {
  return BUILDERS[language](options);
}
