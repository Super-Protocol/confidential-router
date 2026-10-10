import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, type SelectQueryBuilder } from 'typeorm';
import { InviteCarriedRedemption } from '../db/entities/invite-carried-redemption.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { User } from '../db/entities/user.entity.js';
import { InviteAttributionService, type UserInviteAttribution } from './invite-attribution.service.js';
import { type GeneratedInvite, type GenerateInvitesRequest, generateInvites } from './invite-generator.js';

/**
 * Where a code stands, most deliberate cause first — the order `unusableReason`
 * uses, except that a code whose seats are all taken reads as redeemed even after
 * it expires: "who used it" is the more useful answer than "it is past its date".
 */
export type InviteCodeStatus = 'active' | 'redeemed' | 'expired' | 'withdrawn';

/** How an account came to exist. */
export type SignUpOrigin = 'invite' | 'bootstrap' | 'open';

export interface InviteCodeRedeemer {
  /**
   * Null for a redemption carried over by a CSV import (SUP-272) whose address
   * belongs to no account on this deployment.
   */
  userId: string | null;
  /** Null when the account has since been deleted from Better Auth's table. */
  email: string | null;
  redeemedAt: Date;
  /** Redeemed on another deployment and imported, rather than redeemed here. */
  carried: boolean;
}

export interface AdminInviteCode {
  id: string;
  /** Normalised. */
  code: string;
  campaign: string;
  grantMicros: number;
  maxRedemptions: number;
  redemptionCount: number;
  status: InviteCodeStatus;
  createdAt: Date;
  expiresAt: Date | null;
  disabledAt: Date | null;
  note: string | null;
  /** Null for a code the CLI minted. */
  issuedByEmail: string | null;
  redeemers: InviteCodeRedeemer[];
}

export interface AdminSignUp {
  userId: string;
  email: string;
  createdAt: Date;
  origin: SignUpOrigin;
  /** Present exactly when `origin` is `invite`. */
  invite: UserInviteAttribution | null;
}

export interface Page<T> {
  totalCount: number;
  nodes: T[];
}

export interface InviteCodeFilter {
  campaign?: string | null;
  status?: InviteCodeStatus | null;
  offset: number;
  limit: number;
}

export interface SignUpFilter {
  origin?: SignUpOrigin | null;
  offset: number;
  limit: number;
}

/** Ids per `IN`, under SQLite's 999 bound-parameter ceiling. */
const ID_CHUNK = 500;

/**
 * The admin console's two lists: every code with who redeemed it, and every
 * account with the code it came from (SUP-268).
 *
 * Read-only, and separate from {@link InvitesService} for the reason
 * {@link InviteAttributionService} is: nothing here spends a code, and the class
 * that does should not grow a second job. Both lists are paged in SQL — a launch
 * campaign is thousands of rows — and enriched per page, so the joins onto Better
 * Auth's `user` table only ever cover what is on screen.
 */
@Injectable()
export class InviteAdminService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly attribution: InviteAttributionService,
  ) {}

  /**
   * Mints a batch for the console — the same `generateInvites` the CLI calls,
   * with the operator recorded on every row.
   */
  issue(request: GenerateInvitesRequest & { issuedByUserId: string }): Promise<GeneratedInvite[]> {
    return generateInvites(this.dataSource, request);
  }

  async codes(filter: InviteCodeFilter, now: Date = new Date()): Promise<Page<AdminInviteCode>> {
    const query = this.dataSource.getRepository(InviteCode).createQueryBuilder('code');
    if (filter.campaign) {
      query.andWhere('code.campaign = :campaign', { campaign: filter.campaign });
    }
    if (filter.status) {
      whereStatus(query, filter.status, now);
    }

    const [rows, totalCount] = await query
      .orderBy('code.createdAt', 'DESC')
      .addOrderBy('code.id', 'ASC')
      .skip(filter.offset)
      .take(filter.limit)
      .getManyAndCount();

    const redemptions = await this.redemptionsOf(rows.map((row) => row.id));
    const carried = await this.carriedOf(rows.map((row) => row.id));
    const accounts = await this.accountsOf(carried.flatMap((row) => (row.email ? [row.email] : [])));
    const emails = await this.emailsOf([
      ...redemptions.map((redemption) => redemption.userId),
      ...rows.flatMap((row) => (row.issuedByUserId ? [row.issuedByUserId] : [])),
    ]);

    return {
      totalCount,
      nodes: rows.map((row) => ({
        id: row.id,
        code: row.code,
        campaign: row.campaign,
        grantMicros: row.grantMicros,
        maxRedemptions: row.maxRedemptions,
        redemptionCount: row.redemptionCount,
        status: inviteCodeStatus(row, now),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        disabledAt: row.disabledAt,
        note: row.note,
        issuedByEmail: row.issuedByUserId ? (emails.get(row.issuedByUserId) ?? null) : null,
        redeemers: [
          ...carried
            .filter((redemption) => redemption.inviteCodeId === row.id)
            .map((redemption) => ({
              userId: redemption.email ? (accounts.get(redemption.email) ?? null) : null,
              email: redemption.email,
              redeemedAt: redemption.redeemedAt,
              carried: true,
            })),
          ...redemptions
            .filter((redemption) => redemption.inviteCodeId === row.id)
            .map((redemption) => ({
              userId: redemption.userId,
              email: emails.get(redemption.userId) ?? null,
              redeemedAt: redemption.redeemedAt,
              carried: false,
            })),
        ],
      })),
    };
  }

  /**
   * Every account, newest first, with how it came to exist.
   *
   * `bootstrapEmail` is `auth.bootstrapEmail`; see {@link bootstrapAccountId} for
   * why that and the account's position are what identify it.
   */
  async signUps(filter: SignUpFilter, bootstrapEmail: string): Promise<Page<AdminSignUp>> {
    const bootstrapId = await this.bootstrapAccountId(bootstrapEmail);
    const query = this.dataSource
      .getRepository(User)
      .createQueryBuilder('account')
      .leftJoin(InviteRedemption, 'redemption', 'redemption.userId = account.id');

    if (filter.origin === 'invite') {
      query.andWhere('redemption.id IS NOT NULL');
    } else if (filter.origin === 'bootstrap') {
      // No bootstrapped account means nothing can match; an impossible id keeps
      // the query shape rather than special-casing an empty page.
      query.andWhere('account.id = :bootstrapId', { bootstrapId: bootstrapId ?? '' });
    } else if (filter.origin === 'open') {
      query.andWhere('redemption.id IS NULL');
      if (bootstrapId) {
        query.andWhere('account.id <> :bootstrapId', { bootstrapId });
      }
    }

    const [accounts, totalCount] = await query
      .orderBy('account.createdAt', 'DESC')
      .addOrderBy('account.id', 'ASC')
      .skip(filter.offset)
      .take(filter.limit)
      .getManyAndCount();

    const invites = await this.attribution.forUsers(accounts.map((account) => account.id));
    return {
      totalCount,
      nodes: accounts.map((account) => {
        const invite = invites.get(account.id) ?? null;
        return {
          userId: account.id,
          email: account.email,
          createdAt: account.createdAt,
          origin: signUpOrigin(account.id, invite !== null, bootstrapId),
          invite,
        };
      }),
    };
  }

  /**
   * The account `POST /auth/bootstrap` created, or null.
   *
   * Nothing records that an account was bootstrapped, and nothing needs to: the
   * plugin only ever creates the *first* account, under `auth.bootstrapEmail`. So
   * the bootstrapped account is the earliest one, if — and only if — it carries
   * that address. A deployment whose first account signed up any other way has
   * none, which is what this answers.
   */
  async bootstrapAccountId(bootstrapEmail: string): Promise<string | null> {
    const [first] = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('account')
      .orderBy('account.createdAt', 'ASC')
      .addOrderBy('account.id', 'ASC')
      .take(1)
      .getMany();
    return first && first.email.toLowerCase() === bootstrapEmail.toLowerCase() ? first.id : null;
  }

  private async redemptionsOf(codeIds: readonly string[]): Promise<InviteRedemption[]> {
    if (codeIds.length === 0) {
      return [];
    }
    const redemptions: InviteRedemption[] = [];
    for (let at = 0; at < codeIds.length; at += ID_CHUNK) {
      redemptions.push(
        ...(await this.dataSource.getRepository(InviteRedemption).find({
          where: { inviteCodeId: In(codeIds.slice(at, at + ID_CHUNK)) },
          order: { redeemedAt: 'ASC' },
        })),
      );
    }
    return redemptions;
  }

  /** Redemptions a CSV import carried over from another deployment, oldest first. */
  private async carriedOf(codeIds: readonly string[]): Promise<InviteCarriedRedemption[]> {
    const carried: InviteCarriedRedemption[] = [];
    for (let at = 0; at < codeIds.length; at += ID_CHUNK) {
      carried.push(
        ...(await this.dataSource.getRepository(InviteCarriedRedemption).find({
          where: { inviteCodeId: In(codeIds.slice(at, at + ID_CHUNK)) },
          order: { redeemedAt: 'ASC', id: 'ASC' },
        })),
      );
    }
    return carried;
  }

  /**
   * The account behind each of these addresses, keyed by address — how a carried
   * redemption is linked to the person once they exist here. Read every time
   * rather than stored, so someone who signs up after the import is linked too.
   */
  async accountsOf(addresses: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(addresses)];
    const accounts = new Map<string, string>();
    for (let at = 0; at < unique.length; at += ID_CHUNK) {
      const users = await this.dataSource.getRepository(User).find({
        where: { email: In(unique.slice(at, at + ID_CHUNK)) },
        select: { id: true, email: true },
      });
      for (const user of users) {
        accounts.set(user.email.toLowerCase(), user.id);
      }
    }
    return accounts;
  }

  private async emailsOf(userIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)];
    const emails = new Map<string, string>();
    for (let at = 0; at < unique.length; at += ID_CHUNK) {
      const users = await this.dataSource.getRepository(User).find({
        where: { id: In(unique.slice(at, at + ID_CHUNK)) },
        select: { id: true, email: true },
      });
      for (const user of users) {
        emails.set(user.id, user.email);
      }
    }
    return emails;
  }
}

export function inviteCodeStatus(
  code: Pick<InviteCode, 'disabledAt' | 'expiresAt' | 'redemptionCount' | 'maxRedemptions'>,
  now: Date,
): InviteCodeStatus {
  if (code.disabledAt) {
    return 'withdrawn';
  }
  if (code.redemptionCount >= code.maxRedemptions) {
    return 'redeemed';
  }
  if (code.expiresAt && code.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  return 'active';
}

export function signUpOrigin(userId: string, redeemed: boolean, bootstrapId: string | null): SignUpOrigin {
  if (redeemed) {
    return 'invite';
  }
  return userId === bootstrapId ? 'bootstrap' : 'open';
}

/**
 * {@link inviteCodeStatus} as a `WHERE`, so a filtered page is paged by the
 * database rather than by discarding rows after the fact. The two must agree;
 * `invite-admin.service.spec.ts` checks every status through both.
 */
function whereStatus(query: SelectQueryBuilder<InviteCode>, status: InviteCodeStatus, now: Date): void {
  const at = { now: now.getTime() };
  switch (status) {
    case 'withdrawn':
      query.andWhere('code.disabledAt IS NOT NULL');
      return;
    case 'redeemed':
      query.andWhere('code.disabledAt IS NULL').andWhere('code.redemptionCount >= code.maxRedemptions');
      return;
    case 'expired':
      query
        .andWhere('code.disabledAt IS NULL')
        .andWhere('code.redemptionCount < code.maxRedemptions')
        .andWhere('code.expiresAt IS NOT NULL AND code.expiresAt <= :now', at);
      return;
    case 'active':
      query
        .andWhere('code.disabledAt IS NULL')
        .andWhere('code.redemptionCount < code.maxRedemptions')
        .andWhere('(code.expiresAt IS NULL OR code.expiresAt > :now)', at);
      return;
  }
}
