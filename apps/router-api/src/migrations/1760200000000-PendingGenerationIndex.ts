import { type MigrationInterface, type QueryRunner, TableIndex } from 'typeorm';

/**
 * The index behind the incomplete-generation sweep (SUP-423).
 *
 * `IncompleteGenerationSweeper` runs `status = 'pending' AND createdAt < cutoff`
 * once a minute on every replica, and nothing in the schema answered it: the two
 * existing indices are both prefixed by `workspaceId`, which the sweep does not
 * filter on. The predicate is narrow — `pending` is a transient state that holds
 * a handful of rows at a time — so the index is partial, and the insert cost is
 * paid only by rows that are actually in flight.
 *
 * Added with the query rather than after it. `generations` is the fastest-growing
 * table here, a plain TypeORM migration cannot build an index `CONCURRENTLY`, and
 * this is the cheapest moment this statement will ever have.
 */
const PENDING_GENERATIONS = new TableIndex({
  name: 'IDX_generations_pending',
  columnNames: ['createdAt'],
  where: "status = 'pending'",
});

export class PendingGenerationIndex1760200000000 implements MigrationInterface {
  name = 'PendingGenerationIndex1760200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createIndex('generations', PENDING_GENERATIONS);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('generations', PENDING_GENERATIONS);
  }
}
