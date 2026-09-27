/**
 * The money rules the Credits screen enforces before it asks the API to move
 * any, mirrored from `BillingService.assertTopUpAmount` (SUP-75).
 *
 * The API is still the authority — these checks exist so a typo is a field
 * error next to the input instead of a round trip that ends in a toast.
 */
import { formatUsd, usdToMicros } from '../../lib/format';

/** Stripe charges whole cents; anything finer cannot be charged exactly. */
const MICROS_PER_CENT = 10_000n;

/** The buttons on the buy-credits card, in micro-USD. */
export const PRESET_TOP_UP_MICROS = ['10000000', '25000000', '50000000', '100000000'] as const;

/** The floor and ceiling the API holds a single top-up to. */
export interface TopUpBounds {
  minTopUpMicros: string;
  maxTopUpMicros: string;
}

/**
 * Parses a typed dollar amount and holds it to what a payment provider can
 * actually charge. Returns the micro-USD string, or the message to show.
 */
export function parseTopUpAmount(value: string, bounds: TopUpBounds): { micros: string } | { error: string } {
  if (value.trim() === '') return { error: 'Enter an amount to buy.' };

  const micros = usdToMicros(value);
  if (micros === null) return { error: 'Enter an amount in dollars, e.g. 25 or 12.50.' };

  const amount = BigInt(micros);
  if (amount % MICROS_PER_CENT !== 0n) return { error: 'Amounts are charged in whole cents, e.g. 12.50.' };
  if (amount < BigInt(bounds.minTopUpMicros)) {
    return { error: `The minimum top-up is ${formatUsd(bounds.minTopUpMicros)}.` };
  }
  if (amount > BigInt(bounds.maxTopUpMicros)) {
    return { error: `The maximum top-up is ${formatUsd(bounds.maxTopUpMicros)}.` };
  }

  return { micros };
}

export interface AutoTopUpFormValues {
  enabled: boolean;
  /** Dollars, as typed. */
  threshold: string;
  /** Dollars, as typed. */
  amount: string;
}

export type AutoTopUpErrors = Partial<Record<'threshold' | 'amount', string>>;

/**
 * A disabled auto top-up validates whatever is in its fields: turning the
 * setting off is how a viewer gets out of a half-filled form, and the API drops
 * both values when `enabled` is false.
 */
export function validateAutoTopUp(values: AutoTopUpFormValues, bounds: TopUpBounds): AutoTopUpErrors {
  if (!values.enabled) return {};

  const errors: AutoTopUpErrors = {};

  if (values.threshold.trim() === '') {
    errors.threshold = 'Set the balance that triggers a top-up.';
  } else if (usdToMicros(values.threshold) === null) {
    errors.threshold = 'Enter an amount in dollars, e.g. 20 or 12.50.';
  }

  const amount = parseTopUpAmount(values.amount, bounds);
  if ('error' in amount) errors.amount = amount.error;

  return errors;
}

export interface AutoTopUpSettingsInput {
  enabled: boolean;
  thresholdMicros: string | null;
  amountMicros: string | null;
}

/** The validated form as `AutoTopUpInput`. Call it only after `validateAutoTopUp` passes. */
export function toAutoTopUpInput(values: AutoTopUpFormValues): AutoTopUpSettingsInput {
  if (!values.enabled) return { enabled: false, thresholdMicros: null, amountMicros: null };
  return {
    enabled: true,
    thresholdMicros: usdToMicros(values.threshold),
    amountMicros: usdToMicros(values.amount),
  };
}

/**
 * The receipt or invoice link a provider left on a ledger entry.
 *
 * The ledger has no receipt column: `CreditTransaction.description` is a
 * human-readable note that "carries the receipt link when there is one"
 * (`docs/contracts/console-graphql.md`). Only `https` is accepted — a
 * description is provider-supplied text, and rendering whatever scheme it named
 * as a link is how a `javascript:` URL ends up in the console.
 */
export function receiptUrlOf(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = description.match(/https:\/\/[^\s<>"']+/);
  return match ? match[0] : null;
}

/** The description with its link removed, so the note does not repeat the URL. */
export function descriptionTextOf(description: string | null | undefined): string {
  if (!description) return '';
  return description
    .replace(/https:\/\/[^\s<>"']+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
