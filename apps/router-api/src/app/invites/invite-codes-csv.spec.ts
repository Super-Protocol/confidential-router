import { describe, expect, it } from 'vitest';
import { parseCsv, unguardCsvField } from '../activity/csv.js';
import {
  INVITE_CODES_CSV_HEADER,
  type InviteCodeCsvSource,
  InviteCodesCsvRefusedError,
  inviteCodesCsvHeader,
  inviteCodesCsvRow,
  microsToUsd,
  readInviteCodesCsv,
} from './invite-codes-csv.js';

const LANDING = 'https://router.superprotocol.com';
const NOW = new Date('2026-10-10T12:00:00.000Z');
const CREATED = new Date('2026-10-01T09:30:00.000Z');

function source(overrides: Partial<InviteCodeCsvSource> = {}): InviteCodeCsvSource {
  return {
    code: 'ABCDEFGHJKMN',
    campaign: 'launch-2026-10',
    grantMicros: 100_000_000,
    status: 'active',
    redeemers: [],
    createdAt: CREATED,
    expiresAt: null,
    disabledAt: null,
    maxRedemptions: 1,
    note: null,
    ...overrides,
  };
}

function fileOf(...codes: InviteCodeCsvSource[]): string {
  return inviteCodesCsvHeader() + codes.map((code) => inviteCodesCsvRow(code, LANDING)).join('');
}

/** A file with one hand-written data row, each field given by column name. */
function fileWith(fields: Partial<Record<(typeof INVITE_CODES_CSV_HEADER)[number], string>>): string {
  const row: Record<string, string> = {
    code: 'ABCD-EFGH-JKMN',
    url: '',
    campaign: 'launch-2026-10',
    grantUsd: '100',
    status: 'active',
    redeemedByEmail: '',
    redeemedAt: '',
    createdAt: CREATED.toISOString(),
    expiresAt: '',
    withdrawnAt: '',
    maxRedemptions: '1',
    note: '',
    ...fields,
  };
  return `${INVITE_CODES_CSV_HEADER.join(',')}\r\n${INVITE_CODES_CSV_HEADER.map((name) => row[name]).join(',')}\r\n`;
}

describe('the exported row', () => {
  it('carries the display code, a link on this deployment’s landing page, and the exact dollar amount', () => {
    const [header, row] = parseCsv(fileOf(source({ grantMicros: 12_500_000, note: 'For the keynote' })));

    expect(header).toEqual([...INVITE_CODES_CSV_HEADER]);
    expect(row).toEqual([
      'ABCD-EFGH-JKMN',
      `${LANDING}/?invite=ABCD-EFGH-JKMN&utm_source=email&utm_medium=invite&utm_campaign=launch-2026-10`,
      'launch-2026-10',
      '12.5',
      'active',
      '',
      '',
      '2026-10-01T09:30:00.000Z',
      '',
      '',
      '1',
      'For the keynote',
    ]);
  });

  it('writes micro-USD as dollars without losing a micro', () => {
    expect(microsToUsd(100_000_000)).toBe('100');
    expect(microsToUsd(1)).toBe('0.000001');
    expect(microsToUsd(25_500_000)).toBe('25.5');
  });
});

describe('the round trip', () => {
  const redeemedAt = new Date('2026-10-03T08:00:00.000Z');
  const CASES: [string, InviteCodeCsvSource][] = [
    ['an unredeemed code', source()],
    ['one with an expiry still ahead', source({ expiresAt: new Date('2026-12-01T00:00:00.000Z') })],
    ['a redeemed code', source({ status: 'redeemed', redeemers: [{ email: 'a@example.com', redeemedAt }] })],
    ['a redeemed code whose account is gone', source({ status: 'redeemed', redeemers: [{ email: null, redeemedAt }] })],
    ['an expired code', source({ status: 'expired', expiresAt: new Date('2026-10-05T00:00:00.000Z') })],
    ['a withdrawn code', source({ status: 'withdrawn', disabledAt: new Date('2026-10-04T00:00:00.000Z') })],
    [
      'a shared code with seats left',
      source({
        maxRedemptions: 5,
        redeemers: [
          { email: 'a@example.com', redeemedAt },
          { email: null, redeemedAt: new Date('2026-10-04T08:00:00.000Z') },
        ],
      }),
    ],
    [
      'a fractional grant and a note a spreadsheet would run',
      source({ grantMicros: 1_234_567, note: '=SUM(A1), "x"' }),
    ],
  ];

  it.each(CASES)('is lossless for %s', (_name, code) => {
    const { rows, errors, repeated } = readInviteCodesCsv(fileOf(code), NOW);

    expect(errors).toEqual([]);
    expect(repeated).toEqual([]);
    expect(rows).toEqual([
      {
        row: 2,
        code: code.code,
        campaign: code.campaign,
        grantMicros: code.grantMicros,
        maxRedemptions: code.maxRedemptions,
        redemptionCount: code.status === 'redeemed' ? code.maxRedemptions : code.redeemers.length,
        expiresAt: code.expiresAt,
        disabledAt: code.disabledAt,
        note: code.note,
        createdAt: code.createdAt,
        redeemers: code.redeemers,
        status: code.status,
      },
    ]);
  });

  it('ignores the url column, so a file from another hostname imports the same', () => {
    const read = readInviteCodesCsv(fileWith({ url: 'https://old.example.com/?invite=ZZZZ-ZZZZ-ZZZZ' }), NOW);
    expect(read.rows[0].code).toBe('ABCDEFGHJKMN');
  });

  it('takes a code in any spelling the invitation carried, and a file saved with a byte-order mark and bare newlines', () => {
    const file = `﻿${fileWith({ code: 'abcd efgh_jkmn' })}`.replaceAll('\r\n', '\n');
    expect(readInviteCodesCsv(file, NOW).rows[0].code).toBe('ABCDEFGHJKMN');
  });
});

describe('preserving where a code stands', () => {
  it('spends every seat of a redeemed code even when the file no longer says who took it', () => {
    const [row] = readInviteCodesCsv(fileWith({ status: 'redeemed', maxRedemptions: '3' }), NOW).rows;
    expect(row).toMatchObject({ status: 'redeemed', redemptionCount: 3, maxRedemptions: 3, redeemers: [] });
  });

  it('keeps a withdrawn code withdrawn when its date was edited out', () => {
    const [row] = readInviteCodesCsv(fileWith({ status: 'withdrawn' }), NOW).rows;
    expect(row).toMatchObject({ status: 'withdrawn', disabledAt: NOW });
  });

  it('imports a code that expired after the file was written as expired, not as an error', () => {
    const read = readInviteCodesCsv(fileWith({ status: 'active', expiresAt: '2026-10-09T00:00:00.000Z' }), NOW);
    expect(read.errors).toEqual([]);
    expect(read.rows[0].status).toBe('expired');
  });

  it('leaves out the later row of a code that appears twice, and says so', () => {
    const file = fileOf(source(), source({ campaign: 'second' }), source({ code: 'NMKJHGFEDCBA' }));
    const read = readInviteCodesCsv(file, NOW);

    expect(read.rows.map((row) => [row.row, row.campaign])).toEqual([
      [2, 'launch-2026-10'],
      [4, 'launch-2026-10'],
    ]);
    expect(read.repeated.map((row) => row.row)).toEqual([3]);
  });
});

describe('refusing what is not this export', () => {
  it.each([
    ['another tool’s CSV', 'email,name\r\na@example.com,A\r\n', 'not an invitation codes export'],
    [
      'the minting CSV, which has no status',
      'code,url\r\nABCD-EFGH-JKMN,https://x\r\n',
      'not an invitation codes export',
    ],
    ['an empty file', '', 'not an invitation codes export'],
    ['a header and nothing else', `${INVITE_CODES_CSV_HEADER.join(',')}\r\n`, 'no codes'],
    ['broken quoting', `${INVITE_CODES_CSV_HEADER.join(',')}\r\n"ABCD,x\r\n`, 'not valid CSV'],
  ])('refuses %s outright', (_name, file, message) => {
    expect(() => readInviteCodesCsv(file, NOW)).toThrow(InviteCodesCsvRefusedError);
    expect(() => readInviteCodesCsv(file, NOW)).toThrow(message);
  });

  it.each([
    [{ code: 'ABCD-EFGH-JKM0' }, '“code”'],
    [{ code: 'ABCD-EFGH' }, '“code”'],
    [{ campaign: 'Launch 2026' }, '“campaign”'],
    [{ grantUsd: '0' }, '“grantUsd”'],
    [{ grantUsd: '$100' }, '“grantUsd”'],
    [{ grantUsd: '1.0000001' }, '“grantUsd”'],
    [{ status: 'spent' }, '“status”'],
    [{ createdAt: '10/01/2026' }, '“createdAt”'],
    [{ expiresAt: 'never' }, '“expiresAt”'],
    [{ withdrawnAt: 'yesterday' }, '“withdrawnAt”'],
    [{ maxRedemptions: '0' }, '“maxRedemptions”'],
    [{ redeemedByEmail: 'a@example.com' }, '“redeemedAt” is empty'],
    [{ redeemedAt: '2026-10-03T08:00:00.000Z', redeemedByEmail: 'a@example.com;b@example.com' }, 'same number'],
    [{ redeemedAt: '2026-10-03T08:00:00.000Z', redeemedByEmail: 'not an address' }, 'not an email'],
    [{ redeemedAt: '2026-10-03T08:00:00.000Z;2026-10-04T08:00:00.000Z', redeemedByEmail: ';' }, '2 redemption(s)'],
    // Contradictions: the status says one thing, the dates and redemptions another.
    [{ status: 'active', redeemedAt: '2026-10-03T08:00:00.000Z', redeemedByEmail: 'a@example.com' }, 'is redeemed'],
    [{ status: 'active', withdrawnAt: '2026-10-03T08:00:00.000Z' }, 'is withdrawn'],
    [{ status: 'expired' }, 'is active'],
    [{ status: 'expired', expiresAt: '2027-01-01T00:00:00.000Z' }, 'is active'],
    [{ status: 'redeemed', withdrawnAt: '2026-10-03T08:00:00.000Z' }, 'is withdrawn'],
  ])('reports %j against its row', (fields, message) => {
    const read = readInviteCodesCsv(fileWith(fields), NOW);

    expect(read.rows).toEqual([]);
    expect(read.errors).toEqual([{ row: 2, message: expect.stringContaining(message) }]);
  });

  it('names every bad row of a file rather than the first, and never quotes a code', () => {
    const header = `${INVITE_CODES_CSV_HEADER.join(',')}\r\n`;
    const good = inviteCodesCsvRow(source(), LANDING);
    const file = `${header}${good}ABCD-EFGH-JKM0,,x,1,active,,,nope,,,1,\r\nshort,row\r\n`;

    const read = readInviteCodesCsv(file, NOW);

    expect(read.rows).toHaveLength(1);
    expect(read.errors.map((error) => error.row)).toEqual([3, 4]);
    expect(JSON.stringify(read.errors)).not.toContain('JKM0');
  });
});

describe('the CSV reader', () => {
  it('reads quoted fields, doubled quotes and newlines inside a field', () => {
    expect(parseCsv('a,"b,1","say ""hi""","two\r\nlines"\r\n,,\r\n')).toEqual([
      ['a', 'b,1', 'say "hi"', 'two\r\nlines'],
      ['', '', ''],
    ]);
  });

  it('skips blank lines and takes a last row with no line end', () => {
    expect(parseCsv('a,b\n\n\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('refuses a quote that is never closed, or text after one that was', () => {
    expect(() => parseCsv('a,"b')).toThrow('never closed');
    expect(() => parseCsv('"a"b,c')).toThrow('after a closing quote');
    expect(() => parseCsv('a"b,c')).toThrow('middle of an unquoted field');
  });

  it('takes the formula guard back off', () => {
    expect(unguardCsvField("'=SUM(A1)")).toBe('=SUM(A1)');
    expect(unguardCsvField("'+plus@example.com")).toBe('+plus@example.com');
    expect(unguardCsvField("it's fine")).toBe("it's fine");
  });
});
