import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/** How much of a reason survives a revert to the narrow column. */
const NARROW_LENGTH = 255;

/**
 * Retypes one reason column, in whichever way the driver preserves the rows.
 *
 * The same shape, and the same reason, as `ExternalGenerationEndpoint1759500000000`'s
 * helper — with the loss reversed. PostgreSQL has the one-line form and
 * `changeColumn` does not use it: on a type change it drops the column and adds
 * it back ("to avoid data conversion", `PostgresQueryRunner.changeColumn`), so
 * every stored reason would be silently replaced by NULL — the widening would
 * erase exactly the text it exists to make room for. SQLite has no
 * `ALTER COLUMN` at all, so there the table rebuild `changeColumn` performs is
 * the only way, and it carries the rows and the dependent indices across.
 */
async function retype(queryRunner: QueryRunner, table: string, column: string, wide: boolean): Promise<void> {
  if (queryRunner.connection.options.type.includes('sqlite')) {
    await queryRunner.changeColumn(
      table,
      column,
      new TableColumn({
        name: column,
        type: wide ? 'text' : 'varchar',
        length: wide ? undefined : String(NARROW_LENGTH),
        isNullable: true,
      }),
    );
    return;
  }
  const type = wide ? 'text' : `character varying(${NARROW_LENGTH})`;
  await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE ${type}`);
}

/**
 * How many rows hold a value the narrow column could not take.
 *
 * `length` and `substr` read the same on PostgreSQL and SQLite, and the
 * camel-case identifiers have to be quoted for PostgreSQL not to fold them.
 */
async function countOversized(queryRunner: QueryRunner, table: string, column: string): Promise<number> {
  const rows = (await queryRunner.query(
    `SELECT COUNT(*) AS "oversized" FROM "${table}" WHERE length("${column}") > ${NARROW_LENGTH}`,
  )) as { oversized: number | string }[];
  return Number(rows[0]?.oversized ?? 0);
}

/**
 * Widens the two verdict-reason columns from `varchar(255)` to `text` (SUP-243).
 *
 * `external_endpoints.lastReason` and `external_endpoint_events.reason` both hold
 * the sidecar's sentence about why an upstream is refused, and both cut it at 255
 * characters. The denial that matters most is the longest one the verifier
 * writes — 332 characters — and what the ceiling removed was its second half:
 *
 *     policy: the built-in pin policy (gatekeeper.default) denied (measurement
 *     74c7…79a7 is not listed in attestedRoots.trustedMeasurements — the Super
 *     Protocol registry does sign it, but in this mode the …
 *
 * The clause that never arrived is "…list is the sole authority and a registry
 * signature admits nothing on its own" — SUP-221 ruling 2, written into the core
 * precisely to pre-empt the misreading *"but Super Protocol signed it"*. So the
 * console rendered the misreading and clipped the correction, which is worse than
 * rendering nothing at all.
 *
 * `text` rather than a longer `varchar` because no honest number exists at this
 * level: these sentences are composed in the gatekeeper, and a stage failure
 * quotes the upstream's own error. The bound that remains is `MAX_REASON_LENGTH`
 * in `status-projection.ts`, several times the verifier's longest wording — which
 * is where a guard against a hostile upstream belongs, on the write, and not as a
 * silent truncation in the schema.
 *
 * Purely widening, so there is no backfill and nothing to re-derive: the stored
 * values are already valid `text`, and the ones that were clipped are verdict
 * projections the next check overwrites (ADR-008 §8).
 *
 * `down` treats the two columns differently, because they are different kinds of
 * record. `external_endpoints.lastReason` is a projection, so it is truncated and
 * the next check rewrites it. `external_endpoint_events.reason` is append-only
 * history that nothing re-derives — truncating it would permanently destroy the
 * second half of exactly the denials this migration exists to keep — so a revert
 * refuses while any event needs the wide column, the way
 * `ExternalGenerationEndpoint1759500000000` refuses rather than inventing or
 * deleting a metered request.
 */
export class ExternalEndpointReasonText1760600000000 implements MigrationInterface {
  name = 'ExternalEndpointReasonText1760600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await retype(queryRunner, 'external_endpoints', 'lastReason', true);
    await retype(queryRunner, 'external_endpoint_events', 'reason', true);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const oversized = await countOversized(queryRunner, 'external_endpoint_events', 'reason');
    if (oversized > 0) {
      throw new Error(
        `Cannot narrow external_endpoint_events.reason back to varchar(${NARROW_LENGTH}): ${oversized} timeline ` +
          'entr(ies) hold a longer verdict reason. That table is append-only and nothing re-derives it, so ' +
          'reverting past SUP-243 means deciding what to do with those explanations first.',
      );
    }
    await retype(queryRunner, 'external_endpoint_events', 'reason', false);

    // The row, unlike the timeline, holds a projection: the next check rewrites
    // it from the live verdict (ADR-008 §8), so truncating costs nothing and
    // beats failing the revert on a value that is about to be replaced.
    await queryRunner.query(
      'UPDATE "external_endpoints" SET "lastReason" = ' +
        `substr("lastReason", 1, ${NARROW_LENGTH}) WHERE length("lastReason") > ${NARROW_LENGTH}`,
    );
    await retype(queryRunner, 'external_endpoints', 'lastReason', false);
  }
}
