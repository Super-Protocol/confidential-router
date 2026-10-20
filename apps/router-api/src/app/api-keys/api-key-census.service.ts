import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';
import { ApiKey } from '../db/entities/api-key.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';

/** Ids per `IN`, under SQLite's 999 bound-parameter ceiling. */
const ID_CHUNK = 500;

/** One account's credentials, as counts. Never any key material (SUP-454). */
export interface ApiKeyCensus {
  /**
   * Person-created keys in the account's workspaces, revoked and expired ones
   * included. See {@link personalKeyCondition} for what is left out.
   */
  total: number;
  /** Keys that would authenticate right now. See {@link liveKeyCondition}. */
  live: number;
  /** The most recent use across those keys, or null if none was ever used. */
  lastUsedAt: Date | null;
}

/**
 * An account with no key at all — what a missing census row means. Frozen
 * because every keyless row on a page is handed this same object.
 */
export const NO_API_KEYS: ApiKeyCensus = Object.freeze({ total: 0, live: 0, lastUsedAt: null });

/** The deployment-wide numbers that size a key-affecting change (SUP-454). */
export interface ApiKeyPopulation {
  /** Every person-created key, whatever its state. */
  keys: number;
  /** Of those, the ones that would authenticate right now. */
  liveKeys: number;
  /** Accounts holding at least one live key — who would have to re-issue. */
  accountsHoldingLiveKey: number;
  /**
   * Live keys in a workspace nobody is a member of.
   *
   * The remainder {@link accountsHoldingLiveKey} cannot speak for: a workspace
   * loses its members when the account is deleted but keeps its keys, so a
   * rebuild can void credentials there is no one left to tell. Normally zero,
   * and worth an operator's attention when it is not.
   */
  liveKeysWithoutAccount: number;
}

/**
 * "This key would authenticate right now", as SQL over the given alias.
 *
 * The same two conditions `ApiKeyService.authenticate` refuses on, and
 * deliberately stricter than `ApiKeyService.countLive`, which looks only at
 * `revokedAt`: that count feeds the `api_key_created` event, where the question
 * is how many keys the workspace has made, while an operator sizing a
 * credential-wide fault is asking how many still work. Takes `:now` as a bound
 * parameter — epoch milliseconds, as `TimestampTransformer` stores them.
 */
export function liveKeyCondition(alias: string): string {
  return `${alias}.revokedAt IS NULL AND (${alias}.expiresAt IS NULL OR ${alias}.expiresAt > :now)`;
}

/**
 * "A person made this key", as SQL over the given alias — every condition in this
 * file is scoped by it, so the whole census means person-created credentials.
 *
 * The exclusion is the console's own chat key (`purpose = 'console_chat'`), and
 * it is about what the census is for. The operational questions are "who must
 * re-issue" and "how much is about to break for them"; a credential the console
 * mints for its own Chat screen and rotates on the next open is neither. Counting
 * it would put a member who once opened Chat on the announce list, and — because
 * revocation is a timestamp and not a delete — would leave every chat key the
 * deployment ever served in `total` for good, so someone who has never made a key
 * would read as `0 live of 12`.
 *
 * Expiry alone does not cover this: a chat key's TTL takes it out of `live`
 * within hours, but never out of `total` or `lastUsedAt`.
 *
 * This is why {@link ApiKeyPopulation.keys} is not the row count of `api_keys`,
 * and deliberately differs from the export bundle's `counts.apiKeys` (SUP-445),
 * which carries what is in the table because that is what it has to restore.
 */
export function personalKeyCondition(alias: string): string {
  return `${alias}.purpose IS NULL`;
}

/**
 * Narrows a query over accounts to those that do — or do not — hold a live key.
 *
 * In SQL rather than by filtering the page afterwards, because the caller pages
 * with `OFFSET`/`LIMIT` and a `totalCount`: discarding rows after the fact would
 * give short pages and a total that counts accounts the operator asked to
 * exclude. The subquery is uncorrelated, so it is also the one number an
 * operator wants — `totalCount` under `holds: true` is the blast radius of a
 * rebuild.
 *
 * `NOT IN` is safe here only because `workspace_members.userId` is a primary
 * column: a NULL in the list would make it match nothing at all.
 */
export function whereHoldsLiveApiKey<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  scope: { accountAlias: string; holds: boolean; now: Date },
): void {
  const holders = query
    .subQuery()
    .select('holder.userId')
    .from(WorkspaceMember, 'holder')
    .innerJoin(ApiKey, 'heldKey', `heldKey.workspaceId = holder.workspaceId AND ${personalKeyCondition('heldKey')}`)
    .where(liveKeyCondition('heldKey'))
    .getQuery();
  query.andWhere(`${scope.accountAlias}.id ${scope.holds ? 'IN' : 'NOT IN'} ${holders}`, {
    now: scope.now.getTime(),
  });
}

/**
 * Who holds a `/v1` credential on this deployment, counted — the operator-side
 * read the SUP-434 rebuild had no way to answer (SUP-454).
 *
 * Separate from {@link ApiKeyService} because nothing here is tenant-scoped: every
 * method deliberately reads across workspaces the caller is not a member of, which
 * is exactly what the console's own `apiKeys(workspaceId)` must never do. The
 * guard is therefore the caller's — `AdminGuard`, on the one resolver that reads
 * this — and keeping the cross-tenant reads in their own class is what makes that
 * boundary visible rather than a habit.
 *
 * Counts and a last-used instant, never a key, a hash or a prefix: the
 * operational questions are "how many" and "who must re-issue", and neither
 * needs anything that identifies a credential.
 *
 * A key belongs to a workspace, not to a person, so an account's census covers
 * every workspace it is a member of — and a key in a shared workspace counts for
 * each member. That is the right answer for "who must re-issue" (every member can
 * use it) and the reason these numbers must not be summed across accounts to get
 * a deployment total; {@link totals} is that, read from `api_keys` directly.
 */
@Injectable()
export class ApiKeyCensusService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * The census for each of these accounts, keyed by user id.
   *
   * Accounts with no key are absent rather than zero — the caller substitutes
   * {@link NO_API_KEYS} — so one `GROUP BY` answers a page however many of its
   * accounts have never made a credential.
   */
  async forUsers(userIds: readonly string[], now: Date = new Date()): Promise<Map<string, ApiKeyCensus>> {
    const unique = [...new Set(userIds)];
    const census = new Map<string, ApiKeyCensus>();
    for (let at = 0; at < unique.length; at += ID_CHUNK) {
      const rows = await this.dataSource
        .getRepository(WorkspaceMember)
        .createQueryBuilder('member')
        .innerJoin(ApiKey, 'heldKey', `heldKey.workspaceId = member.workspaceId AND ${personalKeyCondition('heldKey')}`)
        .where('member.userId IN (:...userIds)', { userIds: unique.slice(at, at + ID_CHUNK) })
        .setParameter('now', now.getTime())
        .select('member.userId', 'userId')
        .addSelect('COUNT(heldKey.id)', 'total')
        .addSelect(`SUM(CASE WHEN ${liveKeyCondition('heldKey')} THEN 1 ELSE 0 END)`, 'live')
        .addSelect('MAX(heldKey.lastUsedAt)', 'lastUsedAt')
        .groupBy('member.userId')
        .getRawMany<{
          userId: string;
          total: string | number;
          live: string | number;
          lastUsedAt: string | number | null;
        }>();

      for (const row of rows) {
        census.set(row.userId, {
          total: Number(row.total),
          live: Number(row.live),
          // `MAX` over a nullable column ignores NULLs, so this is null exactly
          // when none of the account's keys has ever been used.
          lastUsedAt: row.lastUsedAt === null ? null : new Date(Number(row.lastUsedAt)),
        });
      }
    }
    return census;
  }

  /**
   * The deployment-wide population.
   *
   * Read from `api_keys` rather than summed over {@link forUsers}, so a key in a
   * workspace with two members is counted once and a key in a workspace with
   * none is counted at all.
   */
  async totals(now: Date = new Date()): Promise<ApiKeyPopulation> {
    const at = { now: now.getTime() };
    const keys = this.dataSource.getRepository(ApiKey);

    const accounts = await this.dataSource
      .getRepository(WorkspaceMember)
      .createQueryBuilder('member')
      .innerJoin(ApiKey, 'heldKey', `heldKey.workspaceId = member.workspaceId AND ${personalKeyCondition('heldKey')}`)
      .where(liveKeyCondition('heldKey'), at)
      .select('COUNT(DISTINCT member.userId)', 'accounts')
      .getRawOne<{ accounts: string | number | null }>();

    return {
      keys: await keys.count({ where: { purpose: IsNull() } }),
      liveKeys: await this.personalKeys().andWhere(liveKeyCondition('apiKey'), at).getCount(),
      accountsHoldingLiveKey: Number(accounts?.accounts ?? 0),
      liveKeysWithoutAccount: await this.personalKeys()
        .andWhere(liveKeyCondition('apiKey'), at)
        .andWhere((query) => {
          const members = query
            .subQuery()
            .select('1')
            .from(WorkspaceMember, 'anyMember')
            .where('anyMember.workspaceId = apiKey.workspaceId')
            .getQuery();
          return `NOT EXISTS ${members}`;
        })
        .getCount(),
    };
  }

  /** `api_keys` under the alias `apiKey`, already narrowed to person-created rows. */
  private personalKeys(): SelectQueryBuilder<ApiKey> {
    return this.dataSource.getRepository(ApiKey).createQueryBuilder('apiKey').where(personalKeyCondition('apiKey'));
  }
}
