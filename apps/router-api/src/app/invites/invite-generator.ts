import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { csvRow } from '../activity/csv.js';
import { isUniqueViolation } from '../billing/index.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { formatInviteCode, inviteUrl, mintInviteCode } from './invite-code.js';

export interface GenerateInvitesRequest {
  count: number;
  grantMicros: number;
  campaign: string;
  maxRedemptions: number;
  expiresAt: Date | null;
  note: string | null;
  /** Origin the mailed links point at, e.g. `https://router.superprotocol.com`. */
  landingBaseUrl: string;
}

export interface GeneratedInvite {
  /** Display form, `ABCD-EFGH-JKMN`. */
  code: string;
  url: string;
}

/** Codes per `INSERT`. Small enough for SQLite's bound-parameter ceiling. */
const BATCH = 250;

/** A batch that keeps colliding is a broken random source, not bad luck. */
const MAX_BATCH_ATTEMPTS = 5;

export const INVITE_CSV_HEADER = ['code', 'url'] as const;

/**
 * Mints `count` codes for one campaign and returns them in the order the CSV
 * will carry them.
 *
 * Written against a `DataSource` rather than as a Nest provider because its only
 * caller is the CLI, which has no application to boot: it needs the entities and
 * a connection, not guards, config injection or an HTTP server.
 *
 * Collisions are retried per batch rather than per code. At 30^12 a collision
 * inside a 5000-code campaign is a ~10^-10 event, so the retry is not a
 * performance concern — it is there so the unique index, and not a `SELECT` that
 * could race, is what guarantees uniqueness.
 */
export async function generateInvites(
  dataSource: DataSource,
  request: GenerateInvitesRequest,
): Promise<GeneratedInvite[]> {
  const generated: GeneratedInvite[] = [];
  const now = new Date();

  for (let minted = 0; minted < request.count; minted += BATCH) {
    const size = Math.min(BATCH, request.count - minted);
    generated.push(...(await insertBatch(dataSource.manager, { ...request, count: size }, now)));
  }
  return generated;
}

async function insertBatch(
  manager: EntityManager,
  request: GenerateInvitesRequest,
  now: Date,
): Promise<GeneratedInvite[]> {
  for (let attempt = 1; ; attempt += 1) {
    const rows = Array.from({ length: request.count }, () => ({
      id: randomUUID(),
      code: mintInviteCode(),
      grantMicros: request.grantMicros,
      campaign: request.campaign,
      maxRedemptions: request.maxRedemptions,
      redemptionCount: 0,
      expiresAt: request.expiresAt,
      disabledAt: null,
      note: request.note,
      createdAt: now,
    }));
    try {
      await manager.insert(InviteCode, rows);
      return rows.map((row) => ({
        code: formatInviteCode(row.code),
        url: inviteUrl({ landingBaseUrl: request.landingBaseUrl, campaign: row.campaign, code: row.code }),
      }));
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= MAX_BATCH_ATTEMPTS) {
        throw error;
      }
    }
  }
}

/** The CSV the mailing tool consumes: `code,url`, one row per invitation. */
export function invitesCsv(invites: readonly GeneratedInvite[]): string {
  return [csvRow([...INVITE_CSV_HEADER]), ...invites.map((invite) => csvRow([invite.code, invite.url]))].join('');
}
