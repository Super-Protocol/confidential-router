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

const MAX_DEPTH = 8;

/**
 * Replaces the value of any key whose name looks sensitive with `[REDACTED]`.
 * Applied to every structured log record: this service handles API keys, OAuth
 * client secrets and session tokens, and a log line is the easiest place for one
 * to escape the process.
 */
export function redact(value: unknown, sensitiveKeys: string[] = DEFAULT_SENSITIVE_KEYS): unknown {
  return walk(value, { sensitiveKeys, depth: 0, seen: new WeakSet<object>() });
}

interface WalkState {
  sensitiveKeys: string[];
  depth: number;
  seen: WeakSet<object>;
}

function isSensitive(key: string, sensitiveKeys: string[]): boolean {
  const lower = key.toLowerCase();
  return sensitiveKeys.some((candidate) => lower.includes(candidate.toLowerCase()));
}

function walk(value: unknown, state: WalkState): unknown {
  const { sensitiveKeys, depth, seen } = state;
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

  const next: WalkState = { sensitiveKeys, depth: depth + 1, seen };
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, next));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSensitive(key, sensitiveKeys) ? '[REDACTED]' : walk(item, next),
    ]),
  );
}
