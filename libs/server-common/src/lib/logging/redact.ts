/**
 * Keys whose *value* is a credential. Matched as substrings, because a
 * credential arrives under a hundred spellings — `apiKey`, `x-api-key`,
 * `clientSecret`, `refreshToken` — and the cost of over-matching one of them is
 * a redacted field nobody needed.
 */
export const DEFAULT_SENSITIVE_KEYS = [
  'apikey',
  'authorization',
  'clientsecret',
  'cookie',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'sessiontoken',
  'signature',
  'token',
];

/**
 * Keys a request or response body carries user content in — the fields of
 * `/v1/chat/completions`, `/v1/completions` and `/v1/embeddings`, plus the
 * `delta` a stream chunk arrives in.
 *
 * This is the sanitiser `/privacy` §5 and §13 name, and it is deliberately a
 * second list rather than more rows in {@link DEFAULT_SENSITIVE_KEYS}: the two
 * concerns answer different questions. A credential must not escape the
 * process; content must not be *retained* — it is handled in enclave memory
 * because that is what inference is, and the log is simply not a place it is
 * allowed to outlive the request.
 *
 * Matched **exactly**, case-insensitively, not as substrings — which is the
 * other reason the lists are separate. Substring matching would take
 * `contextLength` for `text` and `contentType` / `contentLength` for `content`,
 * and those are most of what an operational log is for. Redacting them would
 * turn this change into a reason to turn the sanitiser off.
 *
 * Nothing logs a body today — pino-http writes request and response metadata
 * only. The list is the guarantee that the day something does, the content does
 * not go with it.
 */
export const DEFAULT_CONTENT_KEYS = [
  'choices',
  'completion',
  'content',
  'delta',
  'embedding',
  'input',
  'messages',
  'prompt',
  'text',
];

const MAX_DEPTH = 8;

const CREDENTIAL_CENSOR = '[REDACTED]';

/**
 * Distinct from {@link CREDENTIAL_CENSOR} on purpose: in an incident review,
 * "a key was nearly logged here" and "a prompt was nearly logged here" are
 * different findings, and the censor is the only thing left to tell them apart.
 */
const CONTENT_CENSOR = '[CONTENT REDACTED]';

/**
 * Replaces the value of any key whose name looks sensitive with `[REDACTED]`,
 * and of any key that holds request or response content with
 * `[CONTENT REDACTED]`.
 *
 * Applied to every structured log record: this service handles API keys, OAuth
 * client secrets and session tokens, and a log line is the easiest place for one
 * to escape the process — and it relays prompts and completions it has promised
 * never to write down.
 */
export function redact(
  value: unknown,
  sensitiveKeys: string[] = DEFAULT_SENSITIVE_KEYS,
  contentKeys: string[] = DEFAULT_CONTENT_KEYS,
): unknown {
  return walk(value, { sensitiveKeys, contentKeys, depth: 0, seen: new WeakSet<object>() });
}

interface WalkState {
  sensitiveKeys: string[];
  contentKeys: string[];
  depth: number;
  seen: WeakSet<object>;
}

function isSensitive(key: string, sensitiveKeys: string[]): boolean {
  const lower = key.toLowerCase();
  return sensitiveKeys.some((candidate) => lower.includes(candidate.toLowerCase()));
}

function isContent(key: string, contentKeys: string[]): boolean {
  const lower = key.toLowerCase();
  return contentKeys.some((candidate) => lower === candidate.toLowerCase());
}

function censorFor(key: string, state: WalkState): string | null {
  if (isSensitive(key, state.sensitiveKeys)) {
    return CREDENTIAL_CENSOR;
  }
  return isContent(key, state.contentKeys) ? CONTENT_CENSOR : null;
}

function walk(value: unknown, state: WalkState): unknown {
  const { sensitiveKeys, contentKeys, depth, seen } = state;
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[TRUNCATED]';
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  const next: WalkState = { sensitiveKeys, contentKeys, depth: depth + 1, seen };
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, next));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const censor = censorFor(key, state);
      return [key, censor ?? walk(item, next)];
    }),
  );
}
