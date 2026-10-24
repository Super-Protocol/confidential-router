import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * The failure-run columns on `external_endpoints` (SUP-517).
 *
 * Before this the table recorded the *latest* verdict and nothing about its
 * history, so the one question an operator asks during an outage — "how long has
 * this been failing?" — had no answer on the row. A production upstream lost its
 * gateway route at 2026-10-23 06:11 UTC and answered 503 for 30 hours; every one
 * of those 503s was correct, and nothing counted them.
 *
 * All four are verdict projections like the columns above them, not trust: the
 * boot reset clears them (ADR-008 §8), the export bundle does not carry them, and
 * an import lands them empty. `consecutiveFailures` is `NOT NULL DEFAULT 0` so an
 * existing row needs no backfill — zero is the honest value for a row whose runs
 * were never counted, and the first check after the upgrade starts counting.
 */
export class ExternalEndpointLiveness1760200000000 implements MigrationInterface {
  name = 'ExternalEndpointLiveness1760200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('external_endpoints', [
      // `bigint`, like every other timestamp in this schema: epoch milliseconds
      // through `TimestampTransformer`, identical on PostgreSQL and SQLite.
      new TableColumn({ name: 'lastSuccessAt', type: 'bigint', isNullable: true }),
      new TableColumn({ name: 'lastFailureAt', type: 'bigint', isNullable: true }),
      new TableColumn({ name: 'notServingSince', type: 'bigint', isNullable: true }),
      new TableColumn({ name: 'consecutiveFailures', type: 'integer', isNullable: false, default: 0 }),
    ]);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('external_endpoints', 'consecutiveFailures');
    await queryRunner.dropColumn('external_endpoints', 'notServingSince');
    await queryRunner.dropColumn('external_endpoints', 'lastFailureAt');
    await queryRunner.dropColumn('external_endpoints', 'lastSuccessAt');
  }
}
