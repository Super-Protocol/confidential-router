import { type MigrationInterface, type QueryRunner, TableIndex } from 'typeorm';

/**
 * The index every per-endpoint read of `evidence_snapshots` was missing.
 *
 * `EvidenceService.latestFor` takes one endpoint's newest publication and
 * `snapshots` pages through them, both `ORDER BY issuedAt DESC, fetchedAt DESC`.
 * Nothing served that ordering: `IDX_evidence_snapshots_endpointId` is one
 * column, and `IDX_evidence_snapshots_identity` leads
 * `endpointId, evidenceDigest` — the ordering column sits behind a value neither
 * query constrains. Both engines narrowed to the endpoint and then sorted its
 * entire history to return a single page.
 *
 * That cost grows without a bound anybody enforces: `record` files a row per
 * issuance and `evidence.retentionDays` is a stored preference nothing prunes,
 * so the table grows for the life of the deployment. The console's Overview
 * reads it per load and `GET /v1/models` per request.
 *
 * Ascending, and read backwards — both dialects scan an index in either
 * direction, so a descending twin would only be another index to maintain on
 * every insert.
 *
 * Additive and online-safe: nothing is rewritten, no column changes, and the
 * rows are unchanged either way, so `down()` simply drops it again.
 */
const BY_ISSUED_AT = new TableIndex({
  name: 'IDX_evidence_snapshots_endpointId_issuedAt',
  columnNames: ['endpointId', 'issuedAt', 'fetchedAt'],
});

export class EvidenceSnapshotsByIssuedAt1760200000000 implements MigrationInterface {
  name = 'EvidenceSnapshotsByIssuedAt1760200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createIndex('evidence_snapshots', BY_ISSUED_AT);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('evidence_snapshots', BY_ISSUED_AT);
  }
}
