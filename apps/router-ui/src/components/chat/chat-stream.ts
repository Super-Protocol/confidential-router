/**
 * The chat's inference call: `POST /v1/chat/completions` with `stream: true`.
 *
 * It is the ordinary OpenAI-compatible request, sent to the ordinary gateway with
 * an ordinary workspace key — the same path, the same guard, the same meter and
 * the same billing as any client (`docs/contracts/router-api.md`). There is no
 * console-only inference route and there must not be one: a second path would be
 * a second thing to audit, and the promise the chat makes is precisely that it is
 * not special.
 *
 * Kept free of React so the SSE parsing, the `[DONE]` handling and the OpenAI
 * error shape can be tested against a fake `fetch`.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamOptions {
  /** `https://api.example/v1`, as `chatCredential` returns it. */
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatTurn[];
  /** Called with each text delta, in arrival order. */
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

/** Why a stream stopped. `aborted` is the user pressing Stop, not a failure. */
export type StreamOutcome =
  | { status: 'done' }
  | { status: 'aborted' }
  | { status: 'error'; message: string; code: string | null };

const EVENT_SEPARATOR = '\n\n';
const DONE_PAYLOAD = '[DONE]';

export async function streamChatCompletion(options: StreamOptions): Promise<StreamOutcome> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model: options.model, messages: options.messages, stream: true }),
      signal: options.signal,
    });
  } catch (error) {
    if (isAbort(error, options.signal)) return { status: 'aborted' };
    return { status: 'error', message: `The router could not be reached: ${(error as Error).message}`, code: null };
  }

  if (!response.ok) {
    return await refusalOf(response);
  }
  if (!response.body) {
    return { status: 'error', message: 'The router answered with no body.', code: null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are only parsed once terminated: a delta split across two network
      // chunks is not JSON yet, and parsing the half would drop the token.
      let separator = buffer.indexOf(EVENT_SEPARATOR);
      while (separator !== -1) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + EVENT_SEPARATOR.length);
        const outcome = handleEvent(event, options.onDelta);
        if (outcome === 'done') {
          // Not `reader.cancel()` — the gateway has already finished writing, and
          // cancelling a completed body makes some runtimes report an abort.
          return { status: 'done' };
        }
        separator = buffer.indexOf(EVENT_SEPARATOR);
      }
    }
  } catch (error) {
    if (isAbort(error, options.signal)) return { status: 'aborted' };
    return { status: 'error', message: `The stream ended early: ${(error as Error).message}`, code: null };
  }

  // A stream that ends without `[DONE]`: everything received has been delivered,
  // so this is a complete-enough answer rather than an error to show.
  return { status: 'done' };
}

/** Returns `'done'` on the terminating sentinel, `'continue'` otherwise. */
function handleEvent(event: string, onDelta: (delta: string) => void): 'done' | 'continue' {
  const payload = dataPayloadOf(event);
  if (payload === null) return 'continue';
  if (payload === DONE_PAYLOAD) return 'done';

  let chunk: unknown;
  try {
    chunk = JSON.parse(payload);
  } catch {
    // The contract says anything that is not JSON passes through untouched, so a
    // comment or a provider extension must not end the stream.
    return 'continue';
  }
  const delta = deltaOf(chunk);
  if (delta) onDelta(delta);
  return 'continue';
}

/** The `data:` payload, with a multi-line payload rejoined as SSE requires. */
export function dataPayloadOf(event: string): string | null {
  const lines = event.split('\n').filter((line) => line.startsWith('data:'));
  if (lines.length === 0) return null;
  return lines.map((line) => line.slice('data:'.length).replace(/^ /, '')).join('\n');
}

function deltaOf(chunk: unknown): string {
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return '';
  let text = '';
  for (const choice of choices) {
    const content = (choice as { delta?: { content?: unknown } }).delta?.content;
    if (typeof content === 'string') text += content;
  }
  return text;
}

/**
 * A refusal, read out of the OpenAI error envelope.
 *
 * The gateway's refusals are the interesting ones — `insufficient_credits`,
 * `rate_limit_exceeded`, `model_not_in_key_scope`, `api_key_expired` — and the
 * screen needs the `code` to say something better than "request failed". The
 * message is the server's own, because it is written for the caller.
 */
async function refusalOf(response: Response): Promise<StreamOutcome> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'error', message: `The router answered ${response.status}.`, code: null };
  }
  const error = (body as { error?: { message?: unknown; code?: unknown } }).error;
  const message =
    typeof error?.message === 'string' && error.message.length > 0
      ? error.message
      : `The router answered ${response.status}.`;
  return { status: 'error', message, code: typeof error?.code === 'string' ? error.code : null };
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error as { name?: string })?.name === 'AbortError';
}
