/**
 * Money in this service is an integer number of micro-USD, never a float and
 * never a decimal string (ADR-005 §1). These helpers are the only places a
 * micro amount is converted to or from anything else.
 */

export const MICROS_PER_USD = 1_000_000;

/** Stripe charges whole cents; a micro amount that is not a whole cent cannot be billed. */
export const MICROS_PER_CENT = 10_000;

export class InvalidMicroAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMicroAmountError';
  }
}

/**
 * Parses the `Micros` wire format — an integer as a string.
 *
 * A string rather than a GraphQL `Int` because a balance is a `bigint` in the
 * database and 2^31 micro-USD is only $2147; a string also survives JSON
 * round-trips in every client without silent float coercion.
 */
export function parseMicros(value: string, field = 'amount'): number {
  if (!/^-?\d+$/.test(value.trim())) {
    throw new InvalidMicroAmountError(`${field} must be an integer number of micro-USD, got "${value}".`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidMicroAmountError(`${field} is out of range.`);
  }
  return parsed;
}

/**
 * Parses a USD amount a human typed — `100`, `2.50`, `0.000001` — into micros.
 *
 * Only for operator input (the invitation CLI's `--grant`). Everything on the
 * wire is already micros, which is the whole point of {@link parseMicros}: this
 * function exists because `--grant 100000000` on a command line is a typo waiting
 * to happen, and `--grant 100` is not.
 */
export function usdToMicros(value: string, field = 'amount'): number {
  const text = value.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) {
    throw new InvalidMicroAmountError(
      `${field} must be a positive USD amount with at most six decimal places, got "${value}".`,
    );
  }
  const micros = Number(match[1]) * MICROS_PER_USD + Number((match[2] ?? '').padEnd(6, '0'));
  if (micros <= 0) {
    throw new InvalidMicroAmountError(`${field} must be greater than zero.`);
  }
  if (!Number.isSafeInteger(micros)) {
    throw new InvalidMicroAmountError(`${field} is out of range.`);
  }
  return micros;
}

export function formatMicros(value: number): string {
  return String(value);
}

/** `1234567` → `"1.234567"`; used for human-readable descriptions and CSV. */
export function microsToUsdString(value: number): string {
  const negative = value < 0;
  const absolute = Math.abs(value);
  const whole = Math.trunc(absolute / MICROS_PER_USD);
  const fraction = String(absolute % MICROS_PER_USD).padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Refuses anything Stripe could not charge exactly. */
export function microsToCents(value: number): number {
  if (value <= 0) {
    throw new InvalidMicroAmountError('A charge must be a positive amount.');
  }
  if (value % MICROS_PER_CENT !== 0) {
    throw new InvalidMicroAmountError(
      `A charge must be a whole number of cents; ${value} micro-USD is ${value / MICROS_PER_CENT} cents.`,
    );
  }
  return value / MICROS_PER_CENT;
}

export function centsToMicros(cents: number): number {
  return cents * MICROS_PER_CENT;
}
