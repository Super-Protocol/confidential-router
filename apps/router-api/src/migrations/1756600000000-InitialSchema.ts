import { type MigrationInterface, type QueryRunner, Table } from 'typeorm';

/**
 * Initial schema for everything `router-api` owns.
 *
 * Written against TypeORM's `Table` API rather than raw SQL so one migration
 * produces the same schema on PostgreSQL and SQLite (`docs/contracts/data-model.md`).
 * The four Better Auth tables (`user`, `session`, `account`, `verification`) are
 * deliberately absent: Better Auth's own migration creates them, and nothing here
 * takes a database-level foreign key on `user` so the two stay independent
 * (ADR-004 §3).
 */

const ID = { type: 'varchar', length: '64' } as const;
const MODEL_ID = { type: 'varchar', length: '255' } as const;

/**
 * SQLite has no boolean literal, and TypeORM's SQLite driver normalises entity
 * defaults to `1`/`0`. Emitting the driver's own form here is what keeps the
 * migrated schema byte-identical to the one the entities describe on both
 * databases — `migrations.spec.ts` asserts exactly that.
 */
function bool(queryRunner: QueryRunner, value: boolean): string {
  const isSqlite = queryRunner.connection.options.type.includes('sqlite');
  if (isSqlite) {
    return value ? '1' : '0';
  }
  return value ? 'true' : 'false';
}

export class InitialSchema1756600000000 implements MigrationInterface {
  name = 'InitialSchema1756600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'workspaces',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'name', type: 'varchar', length: '255' },
          { name: 'slug', type: 'varchar', length: '64' },
          { name: 'balanceMicros', type: 'bigint', default: 0 },
          { name: 'stripeCustomerId', type: 'varchar', length: '255', isNullable: true },
          { name: 'autoTopUpEnabled', type: 'boolean', default: bool(queryRunner, false) },
          { name: 'autoTopUpThresholdMicros', type: 'bigint', isNullable: true },
          { name: 'autoTopUpAmountMicros', type: 'bigint', isNullable: true },
          { name: 'autoTopUpLastAt', type: 'bigint', isNullable: true },
          { name: 'createdAt', type: 'bigint' },
        ],
        indices: [{ name: 'IDX_workspaces_slug', columnNames: ['slug'], isUnique: true }],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'workspace_members',
        columns: [
          { name: 'workspaceId', ...ID, isPrimary: true },
          { name: 'userId', ...ID, isPrimary: true },
          { name: 'role', type: 'varchar', length: '16', default: "'member'" },
          { name: 'createdAt', type: 'bigint' },
        ],
        foreignKeys: [
          { columnNames: ['workspaceId'], referencedTableName: 'workspaces', referencedColumnNames: ['id'], onDelete: 'CASCADE' },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'api_keys',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'workspaceId', ...ID },
          { name: 'name', type: 'varchar', length: '255' },
          { name: 'keyHash', type: 'varchar', length: '64' },
          { name: 'prefix', type: 'varchar', length: '16' },
          { name: 'modelScope', type: 'text', isNullable: true },
          { name: 'spendLimitMicros', type: 'bigint', isNullable: true },
          { name: 'spentTotalMicros', type: 'bigint', default: 0 },
          { name: 'requestsPerMinute', type: 'integer', isNullable: true },
          { name: 'tokensPerMinute', type: 'integer', isNullable: true },
          { name: 'expiresAt', type: 'bigint', isNullable: true },
          { name: 'lastUsedAt', type: 'bigint', isNullable: true },
          { name: 'revokedAt', type: 'bigint', isNullable: true },
          { name: 'createdByUserId', ...ID, isNullable: true },
          { name: 'createdAt', type: 'bigint' },
        ],
        indices: [
          { name: 'IDX_api_keys_keyHash', columnNames: ['keyHash'], isUnique: true },
          { name: 'IDX_api_keys_workspaceId', columnNames: ['workspaceId'] },
        ],
        foreignKeys: [
          { columnNames: ['workspaceId'], referencedTableName: 'workspaces', referencedColumnNames: ['id'], onDelete: 'CASCADE' },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'endpoints',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'name', type: 'varchar', length: '64' },
          { name: 'hostname', type: 'varchar', length: '255' },
          { name: 'tee', type: 'varchar', length: '128' },
          { name: 'evidenceUrl', type: 'varchar', length: '2048', isNullable: true },
          { name: 'enabled', type: 'boolean', default: bool(queryRunner, true) },
          { name: 'updatedAt', type: 'bigint' },
        ],
        indices: [
          { name: 'IDX_endpoints_name', columnNames: ['name'], isUnique: true },
          { name: 'IDX_endpoints_hostname', columnNames: ['hostname'], isUnique: true },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'models',
        columns: [
          { name: 'id', ...MODEL_ID, isPrimary: true },
          { name: 'name', type: 'varchar', length: '255' },
          { name: 'litellmModel', type: 'varchar', length: '255' },
          { name: 'endpointId', ...ID },
          { name: 'contextLength', type: 'integer' },
          { name: 'capabilities', type: 'text' },
          { name: 'promptPer1mMicros', type: 'bigint' },
          { name: 'completionPer1mMicros', type: 'bigint' },
          { name: 'tee', type: 'varchar', length: '128' },
          { name: 'enabled', type: 'boolean', default: bool(queryRunner, true) },
          { name: 'updatedAt', type: 'bigint' },
        ],
        indices: [{ name: 'IDX_models_endpointId', columnNames: ['endpointId'] }],
        foreignKeys: [
          { columnNames: ['endpointId'], referencedTableName: 'endpoints', referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'evidence_snapshots',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'endpointId', ...ID },
          { name: 'fetchedAt', type: 'bigint' },
          { name: 'issuedAt', type: 'bigint' },
          { name: 'evidenceDigest', type: 'varchar', length: '128' },
          { name: 'evidenceDigestHex', type: 'varchar', length: '64' },
          { name: 'certFingerprint', type: 'varchar', length: '128' },
          { name: 'quoteFormat', type: 'varchar', length: '64', isNullable: true },
          { name: 'containerImages', type: 'text' },
          { name: 'chainSummary', type: 'text' },
          { name: 'measurements', type: 'text', isNullable: true },
          { name: 'jws', type: 'text' },
          { name: 'bundle', type: 'text' },
        ],
        indices: [
          { name: 'IDX_evidence_snapshots_endpointId', columnNames: ['endpointId'] },
          {
            name: 'IDX_evidence_snapshots_identity',
            columnNames: ['endpointId', 'evidenceDigest', 'certFingerprint', 'issuedAt'],
            isUnique: true,
          },
        ],
        foreignKeys: [
          { columnNames: ['endpointId'], referencedTableName: 'endpoints', referencedColumnNames: ['id'], onDelete: 'CASCADE' },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'generations',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'workspaceId', ...ID },
          { name: 'apiKeyId', ...ID, isNullable: true },
          { name: 'modelId', ...MODEL_ID },
          { name: 'endpointId', ...ID },
          { name: 'evidenceSnapshotId', ...ID, isNullable: true },
          { name: 'evidenceDigest', type: 'varchar', length: '128', isNullable: true },
          { name: 'promptTokens', type: 'integer', default: 0 },
          { name: 'completionTokens', type: 'integer', default: 0 },
          { name: 'costMicros', type: 'bigint', default: 0 },
          { name: 'promptPer1mMicros', type: 'bigint' },
          { name: 'completionPer1mMicros', type: 'bigint' },
          { name: 'streamed', type: 'boolean', default: bool(queryRunner, false) },
          { name: 'status', type: 'varchar', length: '16', default: "'ok'" },
          { name: 'errorCode', type: 'varchar', length: '64', isNullable: true },
          { name: 'finishReason', type: 'varchar', length: '64', isNullable: true },
          { name: 'latencyMs', type: 'integer', default: 0 },
          { name: 'timeToFirstTokenMs', type: 'integer', isNullable: true },
          { name: 'tokensPerSecond', type: 'real', isNullable: true },
          { name: 'requestId', type: 'varchar', length: '64', isNullable: true },
          { name: 'clientIpHash', type: 'varchar', length: '64', isNullable: true },
          { name: 'createdAt', type: 'bigint' },
        ],
        indices: [
          { name: 'IDX_generations_workspaceId', columnNames: ['workspaceId'] },
          { name: 'IDX_generations_workspaceId_createdAt', columnNames: ['workspaceId', 'createdAt'] },
        ],
        foreignKeys: [
          { columnNames: ['workspaceId'], referencedTableName: 'workspaces', referencedColumnNames: ['id'], onDelete: 'CASCADE' },
          { columnNames: ['apiKeyId'], referencedTableName: 'api_keys', referencedColumnNames: ['id'], onDelete: 'SET NULL' },
          { columnNames: ['modelId'], referencedTableName: 'models', referencedColumnNames: ['id'], onDelete: 'RESTRICT' },
          {
            columnNames: ['evidenceSnapshotId'],
            referencedTableName: 'evidence_snapshots',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'credit_transactions',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'workspaceId', ...ID },
          { name: 'kind', type: 'varchar', length: '16' },
          { name: 'amountMicros', type: 'bigint' },
          { name: 'reference', type: 'varchar', length: '128', isNullable: true },
          { name: 'description', type: 'varchar', length: '512', isNullable: true },
          { name: 'idempotencyKey', type: 'varchar', length: '128' },
          { name: 'createdAt', type: 'bigint' },
        ],
        indices: [
          { name: 'IDX_credit_transactions_workspaceId', columnNames: ['workspaceId'] },
          { name: 'IDX_credit_transactions_idempotencyKey', columnNames: ['idempotencyKey'], isUnique: true },
        ],
        foreignKeys: [
          { columnNames: ['workspaceId'], referencedTableName: 'workspaces', referencedColumnNames: ['id'], onDelete: 'CASCADE' },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'user_preferences',
        columns: [
          { name: 'userId', ...ID, isPrimary: true },
          { name: 'archiveEvidence', type: 'boolean', default: bool(queryRunner, true) },
          { name: 'evidenceRetentionDays', type: 'integer', default: 90 },
          { name: 'notifyOnMeasurementChange', type: 'boolean', default: bool(queryRunner, true) },
          { name: 'desktopNotifications', type: 'boolean', default: bool(queryRunner, false) },
          { name: 'emailReceipts', type: 'boolean', default: bool(queryRunner, true) },
          { name: 'updatedAt', type: 'bigint' },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'activity_rollups',
        columns: [
          { name: 'workspaceId', ...ID, isPrimary: true },
          { name: 'modelId', ...MODEL_ID, isPrimary: true },
          { name: 'apiKeyId', ...ID, isPrimary: true, default: "''" },
          { name: 'bucket', type: 'bigint', isPrimary: true },
          { name: 'requests', type: 'integer', default: 0 },
          { name: 'coveredRequests', type: 'integer', default: 0 },
          { name: 'promptTokens', type: 'bigint', default: 0 },
          { name: 'completionTokens', type: 'bigint', default: 0 },
          { name: 'costMicros', type: 'bigint', default: 0 },
        ],
      }),
      true,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'activity_rollups',
      'user_preferences',
      'credit_transactions',
      'generations',
      'evidence_snapshots',
      'models',
      'endpoints',
      'api_keys',
      'workspace_members',
      'workspaces',
    ]) {
      await queryRunner.dropTable(table, true, true, true);
    }
  }
}
