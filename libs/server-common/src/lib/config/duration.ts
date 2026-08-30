import { z } from 'zod';

const DURATION = /^(\d+(?:ms|s|m|h))+$/;
const PART = /(\d+)(ms|s|m|h)/g;

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * Parses the duration grammar the JSON schemas use (`5s`, `120s`, `1h30m`) into
 * milliseconds. Kept next to the schema helpers so config stays the only place
 * that knows about the string form — everything downstream sees a number.
 */
export function parseDuration(input: string): number {
  if (!DURATION.test(input)) {
    throw new Error(`Invalid duration "${input}": expected a sequence of <number><ms|s|m|h>, e.g. "5s" or "1h30m".`);
  }
  let total = 0;
  for (const [, amount, unit] of input.matchAll(PART)) {
    total += Number(amount) * UNIT_MS[unit];
  }
  return total;
}

/**
 * A duration string in the config, exposed to the app as milliseconds.
 *
 * The default is applied with `.prefault` rather than inside the preprocessor so
 * Zod knows the key is optional — which is what lets an enclosing object be
 * defaulted with `.prefault({})`.
 */
export function durationMs(defaultValue: string) {
  return z
    .preprocess((value) => (typeof value === 'string' ? parseDuration(value) : value), z.number().int().nonnegative())
    .prefault(parseDuration(defaultValue));
}
