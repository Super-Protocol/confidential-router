import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidenceSnapshot } from './evidence-snapshot.entity.js';
import { Generation } from './generation.entity.js';
import { ENTITIES } from './index.js';

/**
 * Executable versions of the invariants in `docs/contracts/data-model.md`.
 *
 * They walk TypeORM's entity metadata rather than reading the source, so adding
 * the offending column anywhere — including through a base class or a future
 * refactor — fails the build.
 */

let dataSource: DataSource;

beforeAll(async () => {
  dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: ENTITIES });
  await dataSource.initialize();
});

afterAll(async () => {
  await dataSource.destroy();
});

/** Types that can hold an arbitrary-length payload. */
const UNBOUNDED_TYPES = ['text', 'simple-json', 'json', 'jsonb', 'blob', 'bytea', 'simple-array'];

/** Names a content column would plausibly be given. */
const CONTENT_NAMES = [
  'prompt',
  'completion',
  'messages',
  'message',
  'content',
  'text',
  'input',
  'output',
  'response',
  'body',
];

/** Longest string a metering row legitimately needs (a model id). */
const MAX_STRING_LENGTH = 255;

describe('Generation', () => {
  it('has no column of a type that could hold prompt or completion text', () => {
    const offenders = dataSource
      .getMetadata(Generation)
      .columns.filter((column) => UNBOUNDED_TYPES.includes(String(column.type)))
      .map((column) => `${column.propertyName}: ${String(column.type)}`);

    expect(offenders).toEqual([]);
  });

  it('bounds every string column to an identifier-sized length', () => {
    const offenders = dataSource
      .getMetadata(Generation)
      .columns.filter((column) => String(column.type) === 'varchar')
      .filter((column) => !column.length || Number(column.length) > MAX_STRING_LENGTH)
      .map((column) => `${column.propertyName}: varchar(${column.length || 'unbounded'})`);

    expect(offenders).toEqual([]);
  });

  it('has no column named after request or response content', () => {
    const offenders = dataSource
      .getMetadata(Generation)
      .columns.map((column) => column.propertyName)
      .filter((name) => CONTENT_NAMES.includes(name.toLowerCase()));

    expect(offenders).toEqual([]);
  });
});

describe('EvidenceSnapshot', () => {
  it('records no verdict about the evidence it stores', () => {
    // The router publishes evidence and never judges it; verification happens in
    // the user's gatekeeper (ADR-002). A boolean here would be that judgement.
    const metadata = dataSource.getMetadata(EvidenceSnapshot);
    const verdictish = metadata.columns
      .map((column) => column.propertyName)
      .filter((name) => /valid|verified|trusted|verdict|allowed|attested/i.test(name));

    expect(verdictish).toEqual([]);
  });

  it('is unique per (endpoint, digest, certificate, issuedAt) so polling is idempotent', () => {
    const metadata = dataSource.getMetadata(EvidenceSnapshot);
    const unique = metadata.indices.find((index) => index.isUnique);

    expect(unique?.columns.map((column) => column.propertyName)).toEqual([
      'endpointId',
      'evidenceDigest',
      'certFingerprint',
      'issuedAt',
    ]);
  });
});

describe('CreditTransaction', () => {
  it('has no updatedAt, because the ledger is append-only', () => {
    const metadata = dataSource.getMetadata('credit_transactions');
    expect(metadata.columns.map((column) => column.propertyName)).not.toContain('updatedAt');
  });

  it('has a unique idempotency key so a redelivered webhook cannot double-charge', () => {
    const metadata = dataSource.getMetadata('credit_transactions');
    const unique = metadata.indices.filter((index) => index.isUnique);
    expect(unique.flatMap((index) => index.columns.map((column) => column.propertyName))).toContain('idempotencyKey');
  });
});

describe('User', () => {
  it('is mapped read-only: TypeORM never synchronises the Better Auth table', () => {
    const metadata = dataSource.getMetadata('user');
    expect(metadata.synchronize).toBe(false);
  });
});
