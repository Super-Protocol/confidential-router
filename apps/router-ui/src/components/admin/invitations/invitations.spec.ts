import { describe, expect, it } from 'vitest';
import {
  campaignError,
  expiryFromDate,
  invitesCsv,
  invitesText,
  kindOf,
  MAX_GRANT_CREDIT_USD,
  maskCode,
  pageRange,
  signOf,
  validateGrantForm,
} from './invitations';
import { validateIssueForm } from './issue-codes-dialog';

describe('maskCode', () => {
  it('keeps the first group, so codes stay tell-apart-able, and hides the rest', () => {
    expect(maskCode('ABCD-EFGH-JKMN')).toBe('ABCD-••••-••••');
  });
});

describe('invitesCsv', () => {
  it('is the file the CLI writes: a code,url header and CRLF rows', () => {
    expect(
      invitesCsv([
        { code: 'ABCD-EFGH-JKMN', url: 'https://router.example/?invite=ABCD-EFGH-JKMN&utm_campaign=x' },
        { code: 'PQRS-TVWX-YZ23', url: 'https://router.example/?invite=PQRS-TVWX-YZ23&utm_campaign=x' },
      ]),
    ).toBe(
      'code,url\r\n' +
        'ABCD-EFGH-JKMN,https://router.example/?invite=ABCD-EFGH-JKMN&utm_campaign=x\r\n' +
        'PQRS-TVWX-YZ23,https://router.example/?invite=PQRS-TVWX-YZ23&utm_campaign=x\r\n',
    );
  });

  it('quotes a field that would break the row', () => {
    expect(invitesCsv([{ code: 'A', url: 'https://x/?a="b",c' }])).toBe('code,url\r\nA,"https://x/?a=""b"",c"\r\n');
  });

  it('puts one invitation per line on the clipboard', () => {
    expect(
      invitesText([
        { code: 'A', url: 'u1' },
        { code: 'B', url: 'u2' },
      ]),
    ).toBe('A\tu1\nB\tu2');
  });
});

describe('expiryFromDate', () => {
  it('means "valid through that day", UTC — the CLI’s --expires rule', () => {
    expect(expiryFromDate('2026-12-31')).toBe('2027-01-01T00:00:00.000Z');
  });

  it('refuses anything that is not a date', () => {
    expect(expiryFromDate('')).toBeNull();
    expect(expiryFromDate('31/12/2026')).toBeNull();
  });
});

describe('campaignError', () => {
  it('accepts a lowercase slug and names what is wrong with anything else', () => {
    expect(campaignError('launch-2026-10-devs')).toBeNull();
    expect(campaignError('')).toBe('A campaign tag is required.');
    expect(campaignError('Launch 2026')).toContain('lowercase');
  });
});

describe('validateIssueForm', () => {
  const valid = { count: '50', credit: '100', campaign: 'launch', maxRedemptions: '1', expires: '', note: '' };
  const TODAY = '2026-10-09';

  it('passes a batch of fifty at $100', () => {
    expect(validateIssueForm(valid, TODAY)).toEqual({});
  });

  it('holds the API’s limits before the round trip', () => {
    const errors = validateIssueForm(
      { count: '1001', credit: '10000.01', campaign: 'Bad Tag', maxRedemptions: '0', expires: '2026-10-08', note: '' },
      TODAY,
    );
    expect(Object.keys(errors).sort()).toEqual(['campaign', 'count', 'credit', 'expires', 'maxRedemptions']);
  });

  it('refuses a zero credit and a fractional count', () => {
    expect(validateIssueForm({ ...valid, credit: '0' }, TODAY).credit).toBeDefined();
    expect(validateIssueForm({ ...valid, count: '2.5' }, TODAY).count).toBeDefined();
  });

  it('allows an expiry of today — valid through the end of it', () => {
    expect(validateIssueForm({ ...valid, expires: TODAY }, TODAY)).toEqual({});
  });
});

describe('pageRange', () => {
  it('reads like a pager', () => {
    expect(pageRange(0, 50, 230)).toBe('1–50 of 230');
    expect(pageRange(200, 30, 230)).toBe('201–230 of 230');
    expect(pageRange(0, 0, 0)).toBe('0 of 0');
  });
});

describe('validateGrantForm', () => {
  const valid = { amount: '100', movement: 'GRANT' as const, note: '' };
  /** $40, what the dialog's target holds. */
  const BALANCE = '40000000';

  it('passes a $100 grant with no note', () => {
    expect(validateGrantForm(valid, BALANCE)).toEqual({});
  });

  it('refuses nothing, zero and a negative typed into the amount', () => {
    expect(validateGrantForm({ ...valid, amount: '' }, BALANCE).amount).toBeDefined();
    expect(validateGrantForm({ ...valid, amount: '0' }, BALANCE).amount).toBeDefined();
    // The sign is the movement's; a minus in the field is not an amount.
    expect(validateGrantForm({ ...valid, amount: '-5' }, BALANCE).amount).toBeDefined();
  });

  it('holds the API’s ceiling before the round trip', () => {
    expect(validateGrantForm({ ...valid, amount: String(MAX_GRANT_CREDIT_USD) }, BALANCE)).toEqual({});
    expect(validateGrantForm({ ...valid, amount: `${MAX_GRANT_CREDIT_USD}.01` }, BALANCE).amount).toBeDefined();
  });

  it('needs a note only when credit is being removed', () => {
    expect(validateGrantForm({ amount: '10', movement: 'ADJUSTMENT_ADD', note: '' }, BALANCE)).toEqual({});
    expect(validateGrantForm({ amount: '10', movement: 'ADJUSTMENT_REMOVE', note: '' }, BALANCE).note).toBeDefined();
    expect(validateGrantForm({ amount: '10', movement: 'ADJUSTMENT_REMOVE', note: ' ' }, BALANCE).note).toBeDefined();
    expect(validateGrantForm({ amount: '10', movement: 'ADJUSTMENT_REMOVE', note: 'Duplicate' }, BALANCE)).toEqual({});
  });

  it('will not remove more than the account holds', () => {
    const removal = { movement: 'ADJUSTMENT_REMOVE' as const, note: 'Clawback' };
    expect(validateGrantForm({ ...removal, amount: '40' }, BALANCE)).toEqual({});
    expect(validateGrantForm({ ...removal, amount: '40.01' }, BALANCE).amount).toBeDefined();
    // Adding more than the balance is ordinary.
    expect(validateGrantForm({ amount: '400', movement: 'ADJUSTMENT_ADD', note: '' }, BALANCE)).toEqual({});
  });

  it('skips the balance check when the account has no workspace to read one from', () => {
    expect(validateGrantForm({ amount: '10', movement: 'ADJUSTMENT_REMOVE', note: 'Clawback' }, null)).toEqual({});
  });
});

describe('the movement maps onto the API’s kind and sign', () => {
  it('is a positive GRANT, or an ADJUSTMENT either way', () => {
    expect([kindOf('GRANT'), signOf('GRANT')]).toEqual(['GRANT', 1]);
    expect([kindOf('ADJUSTMENT_ADD'), signOf('ADJUSTMENT_ADD')]).toEqual(['ADJUSTMENT', 1]);
    expect([kindOf('ADJUSTMENT_REMOVE'), signOf('ADJUSTMENT_REMOVE')]).toEqual(['ADJUSTMENT', -1]);
  });
});
