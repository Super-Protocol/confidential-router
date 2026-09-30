import { type MigrationInterface, type QueryRunner, Table } from 'typeorm';

/**
 * `chat_threads` and `chat_messages` — server-side console-chat history (SUP-180).
 *
 * These two tables are the one documented exception to "no request content
 * reaches this database". `generations` is untouched and still holds no content;
 * what lands here is the transcript the user asked us to keep. See ADR-007 §4
 * and the `chat_messages` clause in `invariants.spec.ts`, which is what stops the
 * exception spreading.
 *
 * Denis deferred the durability work and accepted the risk (2026-09-30): the
 * in-TEE state disk is ephemeral by design, so a transcript can be lost during
 * infrastructure maintenance, and every surface that mentions storage says so
 * rather than implying a backup nobody takes.
 *
 * Same rules as every migration before it: the dialect-neutral `Table` API so
 * PostgreSQL and SQLite get an identical schema, and no foreign key on `user`,
 * which Better Auth owns (ADR-004 §3). `chat_messages` cascades from its thread,
 * so a thread delete takes its turns with it in one statement.
 */

const ID = { type: 'varchar', length: '64' } as const;

export class ChatHistory1759200000000 implements MigrationInterface {
  name = 'ChatHistory1759200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'chat_threads',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'workspaceId', ...ID },
          { name: 'userId', ...ID },
          { name: 'title', type: 'varchar', length: '128' },
          { name: 'modelId', type: 'varchar', length: '255' },
          { name: 'createdAt', type: 'bigint' },
          { name: 'updatedAt', type: 'bigint' },
        ],
        indices: [
          // The list query and the pruning query are the same shape: this
          // member's threads in this workspace, newest first.
          {
            name: 'IDX_chat_threads_workspaceId_userId_updatedAt',
            columnNames: ['workspaceId', 'userId', 'updatedAt'],
          },
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

    await queryRunner.createTable(
      new Table({
        name: 'chat_messages',
        columns: [
          { name: 'id', ...ID, isPrimary: true },
          { name: 'threadId', ...ID },
          { name: 'role', type: 'varchar', length: '16' },
          // The exception, in one column. Bounded in practice by
          // `chat.maxMessageChars`, which the service enforces before insert.
          { name: 'content', type: 'text' },
          { name: 'error', type: 'varchar', length: '512', isNullable: true },
          { name: 'createdAt', type: 'bigint' },
        ],
        indices: [{ name: 'IDX_chat_messages_threadId_createdAt', columnNames: ['threadId', 'createdAt'] }],
        foreignKeys: [
          {
            columnNames: ['threadId'],
            referencedTableName: 'chat_threads',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
      true,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Messages first: the foreign key points that way.
    await queryRunner.dropTable('chat_messages', true);
    await queryRunner.dropTable('chat_threads', true);
  }
}
