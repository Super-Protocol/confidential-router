import { csvRow, parseCsv, unguardCsvField } from '../activity/csv.js';
import { type InviteCodeStatus, inviteCodeStatus } from './invite-admin.service.js';
import {
  formatInviteCode,
  inviteUrl,
  isInviteCampaignTag,
  looksLikeInviteCode,
  normaliseInviteCode,
} from './invite-code.js';

/**
 * The invitation codes CSV — the file an operator exports from the Codes tab and
 * imports into the next deployment (SUP-272).
 *
 * Pure: text in, rows and row-level errors out. Nothing here touches a database,
 * so every rule about what a file may say is a property of a string. The code and
 * campaign rules are `invite-code.ts`'s own — the ones minting, the lookup and
 * the issuing form already use — and the status of a row is decided by
 * `inviteCodeStatus`, the function the Codes tab shows it with.
 *
 * The first eight columns are the ones a person reads. The four after them are
 * what a code needs to *mean* the same thing on the other side: without
 * `expiresAt` an expired code could only come back as live or as something else,
 * and without `maxRedemptions` a shared code with seats left would come back as a
 * single-use one.
 *
 * `redeemedByEmail` and `redeemedAt` are `;`-separated lists of equal length,
 * oldest first — one entry per redemption, so a shared code keeps all of its
 * redeemers. An entry with no address is an account that no longer exists.
 */
export const INVITE_CODES_CSV_HEADER = [
  'code',
  'url',
  'campaign',
  'grantUsd',
  'status',
  'redeemedByEmail',
  'redeemedAt',
  'createdAt',
  'expiresAt',
  'withdrawnAt',
  'maxRedemptions',
  'note',
] as const;

/** Rows per file. Far above any campaign so far, and what keeps a wrong upload from being planned in full. */
export const MAX_INVITE_CODES_CSV_ROWS = 50_000;

const LIST_SEPARATOR = ';';
const STATUSES: readonly InviteCodeStatus[] = ['active', 'redeemed', 'expired', 'withdrawn'];
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const USD = /^\d{1,12}(\.\d{1,6})?$/;
/** The issuing form's ceiling on seats per code (`IssueInviteCodesInputModel`). */
const MAX_SEATS = 10_000;

export interface InviteCodeCsvRedeemer {
  /** Null when the account no longer exists. */
  email: string | null;
  redeemedAt: Date;
}

/** One code as the export writes it. */
export interface InviteCodeCsvSource {
  /** Normalised. */
  code: string;
  campaign: string;
  grantMicros: number;
  status: InviteCodeStatus;
  redeemers: readonly InviteCodeCsvRedeemer[];
  createdAt: Date;
  expiresAt: Date | null;
  disabledAt: Date | null;
  maxRedemptions: number;
  note: string | null;
}

/** One row of a file, validated: exactly what the import would write. */
export interface InviteCodeCsvRow {
  /** Spreadsheet row: the header is 1, the first code is 2. */
  row: number;
  /** Normalised. */
  code: string;
  campaign: string;
  grantMicros: number;
  maxRedemptions: number;
  redemptionCount: number;
  expiresAt: Date | null;
  disabledAt: Date | null;
  note: string | null;
  createdAt: Date;
  redeemers: InviteCodeCsvRedeemer[];
  /** Where the code will stand once imported, at `now`. */
  status: InviteCodeStatus;
}

export interface InviteCodeCsvRowError {
  row: number;
  message: string;
}

export interface InviteCodesCsvReading {
  rows: InviteCodeCsvRow[];
  errors: InviteCodeCsvRowError[];
}

/** The file is not an invitation codes export at all, so no row of it was read. */
export class InviteCodesCsvRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteCodesCsvRefusedError';
  }
}

/** Micro-USD as the exact dollar amount: `25000000` → `25`, `12500000` → `12.5`. */
export function microsToUsd(micros: number): string {
  const whole = Math.trunc(micros / 1_000_000);
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function usdToMicros(value: string): number | null {
  if (!USD.test(value)) {
    return null;
  }
  const [whole, fraction = ''] = value.split('.');
  const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

export function inviteCodesCsvHeader(): string {
  return csvRow([...INVITE_CODES_CSV_HEADER]);
}

/**
 * One exported row. `url` is built from this deployment's landing page, here and
 * now — the import never reads it back.
 */
export function inviteCodesCsvRow(code: InviteCodeCsvSource, landingBaseUrl: string): string {
  return csvRow([
    formatInviteCode(code.code),
    inviteUrl({ landingBaseUrl, campaign: code.campaign, code: code.code }),
    code.campaign,
    microsToUsd(code.grantMicros),
    code.status,
    code.redeemers.map((redeemer) => redeemer.email ?? '').join(LIST_SEPARATOR),
    code.redeemers.map((redeemer) => redeemer.redeemedAt.toISOString()).join(LIST_SEPARATOR),
    code.createdAt.toISOString(),
    code.expiresAt?.toISOString() ?? '',
    code.disabledAt?.toISOString() ?? '',
    code.maxRedemptions,
    code.note ?? '',
  ]);
}

/**
 * Reads a file into rows and row-level errors.
 *
 * Throws {@link InviteCodesCsvRefusedError} for a file that is not this export —
 * not CSV, another header, nothing in it, too much in it. Everything after that
 * is per row: a bad row is reported with its number and the rest are still
 * checked, so one upload names every problem rather than the first.
 *
 * A code that appears twice is not an error: the later row is left out and
 * reported in `repeated`, the way a code already on the deployment is.
 */
export function readInviteCodesCsv(text: string, now: Date): InviteCodesCsvReading & { repeated: InviteCodeCsvRow[] } {
  let records: string[][];
  try {
    records = parseCsv(text);
  } catch (error) {
    throw new InviteCodesCsvRefusedError(
      `This file is not valid CSV. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const [header, ...data] = records;
  if (!header || !sameHeader(header)) {
    throw new InviteCodesCsvRefusedError(
      `This is not an invitation codes export. Its first row must be exactly: ${INVITE_CODES_CSV_HEADER.join(',')}`,
    );
  }
  if (data.length === 0) {
    throw new InviteCodesCsvRefusedError('The file has a header and no codes.');
  }
  if (data.length > MAX_INVITE_CODES_CSV_ROWS) {
    throw new InviteCodesCsvRefusedError(
      `The file has ${data.length} rows; one import takes at most ${MAX_INVITE_CODES_CSV_ROWS}.`,
    );
  }

  const rows: InviteCodeCsvRow[] = [];
  const repeated: InviteCodeCsvRow[] = [];
  const errors: InviteCodeCsvRowError[] = [];
  const seen = new Set<string>();
  data.forEach((fields, index) => {
    const row = index + 2;
    const read = readRow(fields, row, now);
    if (typeof read === 'string') {
      errors.push({ row, message: read });
    } else if (seen.has(read.code)) {
      repeated.push(read);
    } else {
      seen.add(read.code);
      rows.push(read);
    }
  });
  return { rows, repeated, errors };
}

function sameHeader(header: readonly string[]): boolean {
  return (
    header.length === INVITE_CODES_CSV_HEADER.length &&
    INVITE_CODES_CSV_HEADER.every((name, index) => header[index]?.trim() === name)
  );
}

function instant(value: string): Date | null {
  if (!ISO_INSTANT.test(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A validated row, or the sentence that says what is wrong with it. Never quotes the code. */
function readRow(fields: readonly string[], row: number, now: Date): InviteCodeCsvRow | string {
  if (fields.length !== INVITE_CODES_CSV_HEADER.length) {
    return `Has ${fields.length} column(s); the export has ${INVITE_CODES_CSV_HEADER.length}.`;
  }
  const [rawCode, , rawCampaign, rawGrant, rawStatus, rawEmails, rawRedeemedAt, rawCreated, rawExpires, rawWithdrawn] =
    fields.map((field) => field.trim());
  const rawSeats = fields[10].trim();
  const note = unguardCsvField(fields[11]);

  const code = normaliseInviteCode(rawCode);
  if (!looksLikeInviteCode(code)) {
    return '“code” is not an invitation code.';
  }
  if (!isInviteCampaignTag(rawCampaign)) {
    return '“campaign” must be a lowercase tag such as launch-2026-10-devs.';
  }
  const grantMicros = usdToMicros(rawGrant);
  if (grantMicros === null) {
    return '“grantUsd” must be a dollar amount above 0, such as 100 or 12.5.';
  }
  const status = STATUSES.find((candidate) => candidate === rawStatus);
  if (!status) {
    return `“status” must be one of ${STATUSES.join(', ')}.`;
  }
  const createdAt = instant(rawCreated);
  if (!createdAt) {
    return '“createdAt” must be a UTC timestamp such as 2026-10-10T09:30:00.000Z.';
  }
  const expiresAt = rawExpires === '' ? null : instant(rawExpires);
  if (rawExpires !== '' && !expiresAt) {
    return '“expiresAt” must be empty or a UTC timestamp.';
  }
  const withdrawnAt = rawWithdrawn === '' ? null : instant(rawWithdrawn);
  if (rawWithdrawn !== '' && !withdrawnAt) {
    return '“withdrawnAt” must be empty or a UTC timestamp.';
  }
  if (!/^\d{1,5}$/.test(rawSeats) || Number(rawSeats) < 1 || Number(rawSeats) > MAX_SEATS) {
    return `“maxRedemptions” must be a whole number from 1 to ${MAX_SEATS}.`;
  }
  const maxRedemptions = Number(rawSeats);
  if (note.length > 512) {
    return '“note” is longer than 512 characters.';
  }
  const redeemers = readRedeemers(rawEmails, rawRedeemedAt);
  if (typeof redeemers === 'string') {
    return redeemers;
  }
  if (redeemers.length > maxRedemptions) {
    return `Lists ${redeemers.length} redemption(s) for a code with ${maxRedemptions} seat(s).`;
  }

  const written = {
    // A redeemed code is spent whatever the file can still say about who spent
    // it: every seat is taken, so it can never be redeemed here.
    redemptionCount: status === 'redeemed' ? maxRedemptions : redeemers.length,
    maxRedemptions,
    expiresAt,
    // A withdrawn code stays withdrawn even if the date was edited out.
    disabledAt: status === 'withdrawn' ? (withdrawnAt ?? now) : withdrawnAt,
  };
  const effective = inviteCodeStatus(written, now);
  // The one disagreement that is not a contradiction: a code that was live when
  // the file was written and has passed its expiry since.
  if (effective !== status && !(status === 'active' && effective === 'expired')) {
    return `“status” says ${status}, but the row’s dates and redemptions describe a code that is ${effective}.`;
  }

  return {
    row,
    code,
    campaign: rawCampaign,
    grantMicros,
    note: note === '' ? null : note,
    createdAt,
    redeemers,
    status: effective,
    ...written,
  };
}

function readRedeemers(rawEmails: string, rawRedeemedAt: string): InviteCodeCsvRedeemer[] | string {
  if (rawRedeemedAt === '') {
    return rawEmails === '' ? [] : '“redeemedByEmail” is set but “redeemedAt” is empty.';
  }
  const dates = rawRedeemedAt.split(LIST_SEPARATOR).map((value) => instant(value.trim()));
  const emails = rawEmails.split(LIST_SEPARATOR).map((value) => unguardCsvField(value.trim()).toLowerCase());
  if (dates.some((date) => date === null)) {
    return '“redeemedAt” must be UTC timestamps, separated by “;”.';
  }
  if (emails.length !== dates.length) {
    return '“redeemedByEmail” and “redeemedAt” must list the same number of redemptions.';
  }
  if (emails.some((email) => email !== '' && (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)))) {
    return '“redeemedByEmail” holds something that is not an email address.';
  }
  return dates.map((redeemedAt, index) => ({ email: emails[index] || null, redeemedAt: redeemedAt as Date }));
}
