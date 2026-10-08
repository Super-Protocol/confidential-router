import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * `external_endpoints.measurementInRegistry` — whether the sidecar found the
 * measurement it derived signed in the Super Protocol registry (SUP-251).
 *
 * The sidecar already reports `attestedRoot.inRegistry` on every verdict, denials
 * included; `measurementSource` beside it only names the anchor that *admitted*,
 * so on a denial it is empty and the console had no way to say "this cloud runs a
 * registry-signed image, but it is not on your trust list". The column carries
 * that signal and nothing more — it is informational, never an admission input
 * (ADR-008 §3: the admin trust list is the sole authority).
 *
 * Additive and nullable. Null means "no measurement derived, or not projected
 * since this column existed"; the next poll fills it in, so nothing is backfilled.
 */
export class ExternalEndpointRegistrySignal1759700000000 implements MigrationInterface {
  name = 'ExternalEndpointRegistrySignal1759700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'external_endpoints',
      new TableColumn({ name: 'measurementInRegistry', type: 'boolean', isNullable: true }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('external_endpoints', 'measurementInRegistry');
  }
}
