import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `data-model.md` says the ledger is append-only and that a test asserts no
 * update or delete path exists. This is that test: it reads the only module
 * allowed to write `credit_transactions` and fails if one appears.
 *
 * A source scan rather than a behavioural test on purpose — the property is the
 * *absence* of an operation, which no amount of calling the service can prove.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'ledger.service.ts'), 'utf8');

/** Ways TypeORM can change or remove a row. */
const MUTATING_CALLS = [
  /\.update\(\s*CreditTransaction/,
  /\.delete\(\s*CreditTransaction/,
  /\.remove\(/,
  /\.softDelete\(/,
  /\.softRemove\(/,
  /\.upsert\(\s*CreditTransaction/,
  /\.save\(\s*CreditTransaction/,
  /\bUPDATE\s+credit_transactions\b/i,
  /\bDELETE\s+FROM\s+credit_transactions\b/i,
];

describe('the ledger writer', () => {
  it('has no path that updates or deletes a credit transaction', () => {
    const offenders = MUTATING_CALLS.filter((pattern) => pattern.test(source)).map(String);

    expect(offenders).toEqual([]);
  });

  it('appends with insert only', () => {
    expect(source).toMatch(/manager\.insert\(CreditTransaction/);
  });
});
