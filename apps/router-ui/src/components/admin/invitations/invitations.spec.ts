import { describe, expect, it } from 'vitest';
import {
  accountsHolding,
  apiKeyCount,
  campaignError,
  expiryFromDate,
  invitesCsv,
  invitesText,
  KEY_FILTER,
  maskCode,
  pageRange,
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

describe('the credential census on the account list (SUP-454)', () => {
  it('says how many of an account’s keys still work, and only names the total when it differs', () => {
    expect(apiKeyCount({ total: 3, live: 2 })).toBe('2 live of 3');
    expect(apiKeyCount({ total: 2, live: 2 })).toBe('2 live');
    // Every key revoked is not the same as never having had one, so the total
    // stays on screen.
    expect(apiKeyCount({ total: 2, live: 0 })).toBe('0 live of 2');
  });

  it('answers null for an account with no key, so the table draws a dash and not a zero', () => {
    expect(apiKeyCount({ total: 0, live: 0 })).toBeNull();
  });

  it('agrees with its verb', () => {
    expect(accountsHolding(1)).toBe('1 account holds');
    expect(accountsHolding(0)).toBe('0 accounts hold');
    expect(accountsHolding(8)).toBe('8 accounts hold');
  });

  it('asks the API for either kind by default, and never for "false" by accident', () => {
    expect(KEY_FILTER.all).toBeNull();
    expect(KEY_FILTER.live).toBe(true);
    expect(KEY_FILTER.none).toBe(false);
  });
});
