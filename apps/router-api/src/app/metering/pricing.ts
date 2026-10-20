/**
 * Cost of a generation, in micro-USD.
 *
 * `docs/contracts/router-api.md`: prompt and completion tokens are priced per
 * million and the total is rounded **up** to the next micro-USD, so a request
 * that consumed anything at all is never free.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ModelPricing {
  promptPer1mMicros: number;
  completionPer1mMicros: number;
}

const PER_MILLION = 1_000_000;

export function computeCostMicros(usage: TokenUsage, pricing: ModelPricing): number {
  // Multiply before dividing: the numerator stays an exact integer (a request
  // would need ~9e8 tokens at $1/token to leave the safe-integer range), so the
  // single division is the only place a rounding decision is made.
  const numerator =
    Math.max(0, usage.promptTokens) * pricing.promptPer1mMicros +
    Math.max(0, usage.completionTokens) * pricing.completionPer1mMicros;
  return Math.ceil(numerator / PER_MILLION);
}

/**
 * The smallest sample a generation rate is reported from.
 *
 * Below either floor the quotient describes the measurement and not the model.
 * The window is wall-clock milliseconds, so a 1 ms one carries ~100% of its own
 * value as error; and the first token marks the *start* of the window rather
 * than arriving inside it, so N tokens are spread over N−1 gaps and a tiny N
 * overstates the rate by 1/(N−1). The Logs row that read "2000 tok/s" was two
 * tokens over one millisecond and failed both at once (SUP-424).
 */
const MIN_RATE_TOKENS = 4;
const MIN_RATE_WINDOW_MS = 25;

/**
 * Output tokens per second over the generation window — the time *after* the
 * first token, so a long prefill is never charged to the model's speed.
 *
 * `null` whenever that is not measurable rather than a number that only looks
 * like one: nothing was generated, no first-token time started the window (a
 * request that was not streamed has none, and `generationMs` is `null` for it),
 * or the sample is below the floors above.
 */
export function tokensPerSecond(completionTokens: number, generationMs: number | null): number | null {
  if (generationMs === null || generationMs < MIN_RATE_WINDOW_MS) {
    return null;
  }
  if (completionTokens < MIN_RATE_TOKENS) {
    return null;
  }
  return Number(((completionTokens * 1000) / generationMs).toFixed(3));
}
