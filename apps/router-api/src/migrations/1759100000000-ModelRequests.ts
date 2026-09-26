import { type MigrationInterface, type QueryRunner, Table } from 'typeorm';

/**
 * "Request a model" — the demand signal (SUP-146).
 *
 * Same rules as every migration before it: TypeORM's dialect-neutral `Table`
 * API so PostgreSQL and SQLite get an identical schema, and no foreign key on
 * `user` — Better Auth owns that table (ADR-004 §3).
 *
 * What is missing is the point. There is no unique index here: forty people
 * asking for the same model are forty rows, because the count is the whole
 * value of the table. The three non-unique indices serve the reads —
 * `normalisedModel` for the admin aggregation's `GROUP BY`, `userId` for the
 * per-account rate limit (which counts this table rather than a bucket in
 * memory, so that a restart cannot hand anyone a fresh allowance), and
 * `createdAt` for the export's `since` window. Single columns rather than a
 * composite: an account's requests are few enough that narrowing by `userId`
 * alone leaves a handful of rows to filter by date.
 */

const ID = { type: 'varchar', length: '64' } as const;

/** SQLite has no boolean literal; see the note in `1756600000000-InitialSchema.ts`. */
function bool(queryRunner: QueryRunner, value: boolean): string {
  return queryRunner.connection.options.type.includes('sqlite') ? (value ? '1' : '0') : value ? 'true' : 'false';
}

export class ModelRequests1759100000000 implements MigrationInterface {
  name = 'ModelRequests1759100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'model_requests',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'userId', ...ID },
          { name: 'workspaceId', ...ID },
          { name: 'requestedModel', type: 'varchar', length: '200' },
          { name: 'normalisedModel', type: 'varchar', length: '200' },
          { name: 'note', type: 'text', isNullable: true },
          { name: 'notify', type: 'boolean', default: bool(queryRunner, false) },
          { name: 'source', type: 'varchar', length: '32' },
          { name: 'createdAt', type: 'bigint' },
        ],
        indices: [
          { name: 'IDX_model_requests_userId', columnNames: ['userId'] },
          { name: 'IDX_model_requests_normalisedModel', columnNames: ['normalisedModel'] },
          { name: 'IDX_model_requests_createdAt', columnNames: ['createdAt'] },
        ],
        foreignKeys: [
          {
            columnNames: ['workspaceId'],
            referencedTableName: 'workspaces',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
      true,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('model_requests', true, true, true);
  }
}
