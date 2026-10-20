import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * `evidence_snapshots.hostname` — the hostname a stored publication was fetched
 * from and names as its own.
 *
 * An endpoint row is keyed by its config `name`, so a deployment reconfigured
 * onto a different hostname keeps the row and the snapshots filed under it. The
 * console's "this deployment's evidence digest" then came from whichever of the
 * two names had published most recently, which after a rename was the name the
 * deployment had stopped answering on — and on a hostname taken over from
 * another deployment, that other deployment's digest (SUP-437).
 *
 * Nullable and nothing is backfilled. Null reads as "not recorded", and the
 * reads that scope by this column admit it, so an upgrade does not take every
 * endpoint's evidence off the console until the next poll; the poller stamps a
 * row as soon as it re-observes the publication behind it.
 */
export class EvidenceSnapshotHostname1760200000000 implements MigrationInterface {
  name = 'EvidenceSnapshotHostname1760200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'evidence_snapshots',
      new TableColumn({ name: 'hostname', type: 'varchar', length: '255', isNullable: true }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('evidence_snapshots', 'hostname');
  }
}
