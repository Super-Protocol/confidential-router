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

/** Output tokens per second, or `null` when nothing was generated or timed. */
export function tokensPerSecond(completionTokens: number, generationMs: number): number | null {
  if (completionTokens <= 0 || generationMs <= 0) {
    return null;
  }
  return Number(((completionTokens * 1000) / generationMs).toFixed(3));
}
