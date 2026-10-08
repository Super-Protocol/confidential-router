import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * `external_endpoints.pinnedEvidenceDigest` — the second trust factor (SUP-252) —
 * and `observedCertFingerprint`, which lets the console show what it is asking an
 * admin to approve.
 *
 * External-endpoint trust becomes two-factor: the cloud by its launch measurement
 * (`trusted_measurements`, as before) **and** the specific deployment by the
 * evidence digest an admin pinned for this endpoint. The column is that pin.
 *
 * Nullable, and nothing is backfilled: null means "no deployment approved yet",
 * which the sidecar reports as `digest-not-pinned` and the endpoint serves
 * nothing until an admin pins the digest it has seen. That is deliberately what an
 * upgrade does to an endpoint registered under cloud-granularity trust — a cloud
 * no longer admits every deployment on it, so every existing endpoint needs its
 * deployment approved once.
 *
 * `observedCertFingerprint` is verdict state like `pinnedCertFingerprint`, and
 * wider: the TLS leaf the last *cryptographically verified* report bound its
 * evidence to, whether or not a trust factor then refused it. An approval is made
 * from a refused verdict — `digest-not-pinned`, or `digest-mismatch` after a
 * redeploy — and the evidence summary the admin approves has to be filed against a
 * leaf the sidecar actually observed; `pinnedCertFingerprint` is only set once the
 * endpoint is admitted, which is after the decision it would inform.
 */
export class ExternalEndpointPinnedDigest1759700000000 implements MigrationInterface {
  name = 'ExternalEndpointPinnedDigest1759700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('external_endpoints', [
      new TableColumn({ name: 'pinnedEvidenceDigest', type: 'varchar', length: '128', isNullable: true }),
      new TableColumn({ name: 'observedCertFingerprint', type: 'varchar', length: '128', isNullable: true }),
    ]);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('external_endpoints', 'observedCertFingerprint');
    await queryRunner.dropColumn('external_endpoints', 'pinnedEvidenceDigest');
  }
}
