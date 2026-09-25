import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * `workspaces.firstRequestAt` — when a workspace's first generation was metered
 * (SUP-145).
 *
 * It exists to be *claimed*, not to be read: the `first_request_sent` analytics
 * event has to fire exactly once per workspace, and `UPDATE … SET firstRequestAt
 * = :now WHERE id = :id AND firstRequestAt IS NULL` decides that with one
 * statement, whatever else is in flight. Counting `generations` instead would be
 * a read followed by a decision, which is a race on the one path where several
 * requests legitimately arrive together.
 *
 * Backfilled from `generations` rather than left null on existing rows, so a
 * workspace that was already sending traffic before this migration does not
 * report a first request the next time one arrives.
 *
 * Same rules as the rest of the schema: TypeORM's dialect-neutral API, one
 * `bigint` epoch-millisecond timestamp on both PostgreSQL and SQLite.
 */
export class WorkspaceFirstRequest1758900000000 implements MigrationInterface {
  name = 'WorkspaceFirstRequest1758900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'workspaces',
      new TableColumn({ name: 'firstRequestAt', type: 'bigint', isNullable: true }),
    );

    const escape = (name: string): string => queryRunner.connection.driver.escape(name);
    await queryRunner.query(
      `UPDATE ${escape('workspaces')} SET ${escape('firstRequestAt')} = (
         SELECT MIN(${escape('g')}.${escape('createdAt')}) FROM ${escape('generations')} ${escape('g')}
         WHERE ${escape('g')}.${escape('workspaceId')} = ${escape('workspaces')}.${escape('id')}
       )`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('workspaces', 'firstRequestAt');
  }
}
