import { type MigrationInterface, type QueryRunner, Table } from 'typeorm';

const ID = { type: 'varchar', length: '64' } as const;

/**
 * `mail_address_states` — what the mail provider has told us about an address
 * (SUP-551).
 *
 * The deployment hands a sign-in code to the relay, the relay accepts it at
 * SMTP time and then discards it because the address is on its suppression
 * list. The send succeeds, so nothing in the process has a failure to record;
 * the outcome exists only in the provider's webhooks, and this is where they
 * land. See `MailAddressState`.
 *
 * Additive; nothing existing is touched and nothing is backfilled. An address
 * suppressed before this table existed reappears here on its next bounced
 * send, which is the next time anyone asks for a code.
 */
export class MailAddressStates1760400000000 implements MigrationInterface {
  name = 'MailAddressStates1760400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'mail_address_states',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'email', type: 'varchar', length: '320' },
          { name: 'state', type: 'varchar', length: '16' },
          { name: 'reason', type: 'varchar', length: '32', isNullable: true },
          { name: 'detail', type: 'varchar', length: '512', isNullable: true },
          { name: 'lastDeliveryId', type: 'varchar', length: '128', isNullable: true },
          { name: 'failures', type: 'bigint', default: 0 },
          { name: 'firstEventAt', type: 'bigint' },
          { name: 'lastEventAt', type: 'bigint' },
          { name: 'rejectingSince', type: 'bigint', isNullable: true },
          { name: 'updatedAt', type: 'bigint' },
        ],
        indices: [
          // Unique: one row per address, because this is a state and not a log.
          { name: 'IDX_mail_address_states_email', columnNames: ['email'], isUnique: true },
          // `/health` counts the rejecting rows on every probe.
          { name: 'IDX_mail_address_states_state', columnNames: ['state'] },
        ],
      }),
      true,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('mail_address_states', true, true, true);
  }
}
