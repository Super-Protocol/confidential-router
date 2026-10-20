import type { GatewayContext } from './gateway.types.js';

/**
 * Turning an upstream OpenAI response into the router's.
 *
 * Two rules, from `docs/contracts/router-api.md`. The identity fields become
 * the router's — `id` is the generation id a client can look up, `model` is the
 * router's slug and not LiteLLM's internal name. And the extension fields live
 * *inside* `usage`, exactly as OpenRouter does it, so an OpenAI SDK that
 * validates the envelope ignores them instead of failing on them.
 */

export interface UsageCounts {
  promptTokens: number;
  completionTokens: number;
}

export interface UsageExtension {
  costMicros: number;
  endpoint: string;
  evidenceDigest: string | null;
}

export function readUsage(payload: unknown): UsageCounts | null {
  const usage = asRecord(asRecord(payload)?.usage);
  if (!usage) {
    return null;
  }
  const promptTokens = asCount(usage.prompt_tokens);
  const completionTokens = asCount(usage.completion_tokens);
  if (promptTokens === null && completionTokens === null) {
    return null;
  }
  return { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0 };
}

/** The assistant text in one streaming chunk, for the tokeniser fallback. */
export function deltaTextOf(chunk: unknown): string {
  const choices = asRecord(chunk)?.choices;
  if (!Array.isArray(choices)) {
    return '';
  }
  return choices
    .map((choice) => {
      const record = asRecord(choice);
      const delta = asRecord(record?.delta) ?? asRecord(record?.message);
      const content = delta?.content ?? record?.text;
      return typeof content === 'string' ? content : '';
    })
    .join('');
}

/**
 * Whether one streaming chunk carries assistant output yet.
 *
 * Separate from `deltaTextOf` because the two questions have different answers:
 * the tokeniser fallback only cares about text, while the first-token clock has
 * to start on anything the model produced. A turn that calls a tool streams its
 * arguments in `delta.tool_calls` and never sets `delta.content`, so a clock
 * that watched text alone left every tool-call turn with no time to first token
 * at all — half the streamed rows in Logs (SUP-424).
 *
 * The opener OpenAI sends before the model has produced anything — `role` with
 * an empty `content` — is deliberately not output.
 */
export function hasAssistantOutput(chunk: unknown): boolean {
  const choices = asRecord(chunk)?.choices;
  if (!Array.isArray(choices)) {
    return false;
  }
  return choices.some((choice) => {
    const record = asRecord(choice);
    const delta = asRecord(record?.delta) ?? asRecord(record?.message);
    return (
      isPresent(delta?.content) ||
      isPresent(record?.text) ||
      isPresent(delta?.refusal) ||
      // A thinking model streams its reasoning before any answer, under either
      // of the two spellings in the wild.
      isPresent(delta?.reasoning_content) ||
      isPresent(delta?.reasoning) ||
      isPresent(delta?.tool_calls) ||
      isPresent(delta?.function_call)
    );
  });
}

export function finishReasonOf(chunk: unknown): string | null {
  const choices = asRecord(chunk)?.choices;
  if (!Array.isArray(choices)) {
    return null;
  }
  for (const choice of choices) {
    const reason = asRecord(choice)?.finish_reason;
    if (typeof reason === 'string') {
      return reason;
    }
  }
  return null;
}

/**
 * Rewrites identity and enriches `usage` in place.
 *
 * In place because the payload is the upstream's own object, already parsed:
 * copying it would only add a second full-size allocation per chunk on the hot
 * streaming path.
 */
export function shapeResponse(
  payload: Record<string, unknown>,
  context: GatewayContext,
  extension: UsageExtension | null,
): Record<string, unknown> {
  if ('id' in payload) {
    payload.id = context.generationId;
  }
  if ('model' in payload) {
    payload.model = context.model.id;
  }
  const usage = asRecord(payload.usage);
  if (usage && extension) {
    usage.total_tokens ??= (asCount(usage.prompt_tokens) ?? 0) + (asCount(usage.completion_tokens) ?? 0);
    usage.cost_micros = extension.costMicros;
    usage.endpoint = extension.endpoint;
    usage.evidence_digest = extension.evidenceDigest;
  }
  return payload;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Output, not an empty placeholder: a non-empty string, list or object. */
function isPresent(value: unknown): boolean {
  if (typeof value === 'string' || Array.isArray(value)) {
    return value.length > 0;
  }
  return asRecord(value) !== null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}
