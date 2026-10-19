import type { InviteCodeStatus, SignUpOrigin } from '../../../generated/graphql';
import { formatUsdShort, usdToMicros } from '../../../lib/format';

/**
 * The pure parts of the Invitations section (SUP-268): masking, the CSV, the
 * issuing form's rules and the labels. Kept apart from the components so they
 * are tested as functions.
 */

/** Rows per page of either list. */
export const PAGE_SIZE = 50;

/** Codes per issue — the API's own cap (`MAX_ISSUE_COUNT`). */
export const MAX_ISSUE_COUNT = 1000;

/** Credit per code, in USD — the API's fat-finger ceiling (`MAX_ISSUE_GRANT_MICROS`). */
export const MAX_ISSUE_GRANT_USD = 10_000;

/**
 * One operator credit grant, in USD — `billing.maxCreditGrantMicros`'s default
 * (SUP-406).
 *
 * The *default*, not the deployment's value, which the console cannot see. So
 * this says the form's rule before the round trip and the API says the
 * deployment's after it; a deployment that lowered the ceiling answers with its
 * own number, which the dialog shows.
 */
export const MAX_GRANT_CREDIT_USD = 10_000;

/** What an operator is doing to a balance. The API's `kind` plus the sign. */
export type CreditMovement = 'GRANT' | 'ADJUSTMENT_ADD' | 'ADJUSTMENT_REMOVE';

export const MOVEMENT_LABEL: Record<CreditMovement, string> = {
  GRANT: 'Grant credit',
  ADJUSTMENT_ADD: 'Correction — add credit',
  ADJUSTMENT_REMOVE: 'Correction — remove credit',
};

export const MOVEMENT_HELP: Record<CreditMovement, string> = {
  GRANT: 'New credit nobody paid for: a top-up for a tester, goodwill after an incident.',
  ADJUSTMENT_ADD: 'Puts right a balance that is short — recorded as a correction, not as a new grant.',
  ADJUSTMENT_REMOVE:
    'Takes credit back. Needs billing.allowCreditDebits on the deployment, and can never take a balance below zero.',
};

/** `GRANT` is positive; the two corrections carry the sign. */
export function signOf(movement: CreditMovement): 1 | -1 {
  return movement === 'ADJUSTMENT_REMOVE' ? -1 : 1;
}

export function kindOf(movement: CreditMovement): 'GRANT' | 'ADJUSTMENT' {
  return movement === 'GRANT' ? 'GRANT' : 'ADJUSTMENT';
}

export interface GrantCreditForm {
  /** USD, unsigned — the sign comes from the movement. */
  amount: string;
  movement: CreditMovement;
  note: string;
}

export type GrantCreditErrors = Partial<Record<keyof GrantCreditForm, string>>;

/**
 * The grant form's rules — the API's, said before the round trip rather than
 * after it (`CreditGrantService.assertAmount`).
 *
 * `balanceMicros` is what the account holds, so an operator sees "they only have
 * $40" before the server says it. Null means the account owns no workspace,
 * which the dialog refuses to open on at all.
 */
export function validateGrantForm(form: GrantCreditForm, balanceMicros: string | null): GrantCreditErrors {
  const errors: GrantCreditErrors = {};
  const micros = usdToMicros(form.amount);

  if (micros === null || BigInt(micros) <= 0n) {
    errors.amount = 'A dollar amount above $0.';
  } else if (BigInt(micros) > BigInt(MAX_GRANT_CREDIT_USD) * 1_000_000n) {
    errors.amount = `At most $${MAX_GRANT_CREDIT_USD.toLocaleString('en-US')} in one go.`;
  } else if (
    form.movement === 'ADJUSTMENT_REMOVE' &&
    balanceMicros !== null &&
    BigInt(micros) > BigInt(balanceMicros)
  ) {
    errors.amount = `More than the ${formatUsdShort(balanceMicros)} on this account; a balance cannot go below zero.`;
  }

  if (form.movement === 'ADJUSTMENT_REMOVE' && form.note.trim() === '') {
    errors.note = 'Say why the credit is being taken away.';
  }
  return errors;
}

/** The API's campaign-tag rule (`INVITE_CAMPAIGN_PATTERN`). */
export const CAMPAIGN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * `ABCD-EFGH-JKMN` → `ABCD-••••-••••`: enough to tell two codes apart in a
 * table, not enough to redeem one — the same shape router-api's audit log uses.
 */
export function maskCode(code: string): string {
  return code
    .split('-')
    .map((group, index) => (index === 0 ? group : '•'.repeat(group.length)))
    .join('-');
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * `code,url` with a header and CRLF line ends — byte-for-byte the file the CLI's
 * `invites generate --out` writes, so a mailing tool set up for one takes the
 * other.
 */
export function invitesCsv(codes: readonly { code: string; url: string }[]): string {
  return ['code,url', ...codes.map((invite) => `${csvField(invite.code)},${csvField(invite.url)}`)]
    .map((line) => `${line}\r\n`)
    .join('');
}

/** One invitation per line, link included — what "Copy all" puts on the clipboard. */
export function invitesText(codes: readonly { code: string; url: string }[]): string {
  return codes.map((invite) => `${invite.code}\t${invite.url}`).join('\n');
}

/**
 * A `YYYY-MM-DD` from a date input means "valid through that day", UTC — the
 * CLI's `--expires` rule, so the two surfaces agree on what a date means.
 */
export function expiryFromDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const start = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

export function campaignError(value: string): string | null {
  if (value === '') return 'A campaign tag is required.';
  if (!CAMPAIGN_PATTERN.test(value)) {
    return 'Use a lowercase tag such as launch-2026-10-devs: letters, digits, dots, dashes and underscores.';
  }
  return null;
}

export const STATUS_LABEL: Record<InviteCodeStatus, string> = {
  ACTIVE: 'Unredeemed',
  REDEEMED: 'Redeemed',
  EXPIRED: 'Expired',
  WITHDRAWN: 'Withdrawn',
};

export const STATUS_VARIANT = {
  ACTIVE: 'brand',
  REDEEMED: 'success',
  EXPIRED: 'secondary',
  WITHDRAWN: 'warning',
} as const satisfies Record<InviteCodeStatus, string>;

export const ORIGIN_LABEL: Record<SignUpOrigin, string> = {
  INVITE: 'Invitation',
  BOOTSTRAP: 'Bootstrap',
  OPEN: 'Open sign-up',
};

export const ORIGIN_VARIANT = {
  INVITE: 'brand',
  BOOTSTRAP: 'secondary',
  OPEN: 'outline',
} as const satisfies Record<SignUpOrigin, string>;

/** "1–50 of 230", for a pager. */
export function pageRange(offset: number, shown: number, total: number): string {
  if (total === 0) return '0 of 0';
  return `${offset + 1}–${offset + shown} of ${total}`;
}
