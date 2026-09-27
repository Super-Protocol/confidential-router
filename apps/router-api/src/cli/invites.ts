#!/usr/bin/env node
/**
 * Invitation codes from the command line: mint a campaign's worth, read how one
 * is converting, or take one back.
 *
 *   node dist/cli/invites.js generate --count 5000 --grant 100 \
 *     --campaign launch-2026-10 --expires 2026-12-31 --out codes.csv
 *   node dist/cli/invites.js stats --campaign launch-2026-10
 *   node dist/cli/invites.js disable --code ABCD-EFGH-JKMN
 *   node dist/cli/invites.js disable --campaign launch-2026-10 --unspent-only
 *
 * It talks to the same database as the service, through the same configuration
 * (`CR_API_*`, `conf/router.yaml`) — there is no second source of truth for where
 * the codes live. Generation is the only way codes come into existence: there is
 * deliberately no API for it, because an endpoint that mints credit is a thing to
 * be attacked and a CLI behind an operator's database access is not.
 *
 * Withdrawal is the one operation that also has an API — the admin-gated
 * `disableInviteCodes` mutation. The asymmetry is deliberate and runs in the safe
 * direction: minting creates credit, withdrawing only stops it, and a deployment
 * whose cluster space is published has no shell to run this CLI in when a code
 * turns up on a mailing list (SUP-159).
 */
import 'reflect-metadata';
import { existsSync, writeFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { InvalidMicroAmountError, usdToMicros } from '../app/billing/money.js';
import { loadRouterConfig } from '../app/config.js';
import { buildDataSourceOptions, ensureSqliteDirectory } from '../app/db/data-source.js';
import { generateInvites, invitesCsv } from '../app/invites/invite-generator.js';
import { InviteStatsService } from '../app/invites/invite-stats.service.js';
import {
  describeRestoration,
  describeWithdrawal,
  InviteTargetError,
  type InviteWithdrawalRequest,
  InviteWithdrawalService,
} from '../app/invites/invite-withdrawal.service.js';
import { booleanFlag, integerFlag, type ParsedArgs, parseArgs, requiredFlag, stringFlag, UsageError } from './args.js';

const USAGE = `Usage:
  invites generate --count <n> --grant <usd> --campaign <tag> --out <file.csv>
                   [--expires <YYYY-MM-DD|ISO>] [--max-redemptions <n>]
                   [--note <text>] [--url-base <origin>] [--force]
  invites stats [--campaign <tag>]
  invites disable (--code <CODE> | --campaign <tag>) [--unspent-only]
  invites restore (--code <CODE> | --campaign <tag>)

  --grant is USD, not micros: "--grant 100" grants $100.
  --expires with a bare date means "valid through that day", UTC.
  --out refuses to overwrite an existing file unless --force is given.
  --url-base defaults to invites.landingBaseUrl from the configuration.
  disable withdraws codes: no further sign-up can redeem them, and no credit
    already granted is touched. --unspent-only leaves codes whose seats are all
    taken alone. It exits 1 when nothing matched, so a script can tell a closed
    leak from a mistyped code.
  restore undoes a withdrawal — for the campaign disabled by a wrong flag.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === null || args.flags.has('help')) {
    console.log(USAGE);
    return;
  }

  const config = loadRouterConfig({ onWarning: (message) => console.warn(`[invites] ${message}`) });
  if (config.database.type === 'sqlite') {
    ensureSqliteDirectory(config.database.file);
  }
  // `migrationsRun: false` whatever the configuration says: this tool reads and
  // writes rows, and migrating a production database as a side effect of
  // generating codes is not a thing it should be able to do.
  const dataSource = new DataSource(buildDataSourceOptions({ ...config.database, migrationsRun: false }));
  await dataSource.initialize();

  try {
    switch (args.command) {
      case 'generate':
        await generate(dataSource, args, config.invites.landingBaseUrl);
        break;
      case 'stats':
        await stats(dataSource, args);
        break;
      case 'disable':
        await disable(dataSource, args);
        break;
      case 'restore':
        await restore(dataSource, args);
        break;
      default:
        throw new UsageError(`Unknown command “${args.command}”.`);
    }
  } finally {
    await dataSource.destroy();
  }
}

async function generate(dataSource: DataSource, args: ParsedArgs, defaultUrlBase: string): Promise<void> {
  const out = requiredFlag(args, 'out');
  if (existsSync(out) && !booleanFlag(args, 'force')) {
    throw new UsageError(`${out} already exists. The codes in it are the only copy — pass --force to overwrite.`);
  }
  const count = integerFlag(args, 'count', 0);
  if (count < 1) {
    throw new UsageError('--count must be at least 1.');
  }

  const request = {
    count,
    grantMicros: grantOf(requiredFlag(args, 'grant')),
    campaign: campaignTag(requiredFlag(args, 'campaign')),
    maxRedemptions: integerFlag(args, 'max-redemptions', 1),
    expiresAt: expiryOf(stringFlag(args, 'expires')),
    note: stringFlag(args, 'note') ?? null,
    landingBaseUrl: stringFlag(args, 'url-base') ?? defaultUrlBase,
  };
  if (request.maxRedemptions < 1) {
    throw new UsageError('--max-redemptions must be at least 1.');
  }

  const invites = await generateInvites(dataSource, request);
  // Written once, at the end: a half-written CSV of codes that exist in the
  // database is worse than no CSV at all, because the operator cannot tell which
  // half was mailed.
  writeFileSync(out, invitesCsv(invites), 'utf8');

  console.log(
    `[invites] ${invites.length} codes for “${request.campaign}”, ${request.grantMicros} micro-USD each` +
      `${request.expiresAt ? `, expiring ${request.expiresAt.toISOString()}` : ', no expiry'} → ${out}`,
  );
}

async function stats(dataSource: DataSource, args: ParsedArgs): Promise<void> {
  const campaigns = await new InviteStatsService(dataSource).campaigns(stringFlag(args, 'campaign') ?? null);
  if (campaigns.length === 0) {
    console.log('[invites] No campaigns.');
    return;
  }
  for (const entry of campaigns) {
    console.log(
      `${entry.campaign}: issued ${entry.issued}, redeemed ${entry.redeemed} ` +
        `(${(entry.redemptionRate * 100).toFixed(1)}%), activated ${entry.activated}, ` +
        `granted ${entry.grantedMicros} micro-USD`,
    );
  }
}

/**
 * The kill switch. One command, and the code stops granting credit.
 *
 * Exits 1 when the target matched nothing: an operator closing a leak needs to
 * know the difference between "withdrawn" and "there is no code by that name",
 * and so does whatever ran the command.
 */
async function disable(dataSource: DataSource, args: ParsedArgs): Promise<void> {
  const service = new InviteWithdrawalService(dataSource);
  const result = await service.withdraw({ ...targetFlags(args), unspentOnly: booleanFlag(args, 'unspent-only') });

  console.log(`[invites] ${describeWithdrawal(result)}`);
  if (result.matched === 0) {
    process.exitCode = 1;
  }
}

async function restore(dataSource: DataSource, args: ParsedArgs): Promise<void> {
  const result = await new InviteWithdrawalService(dataSource).restore(targetFlags(args));

  console.log(`[invites] ${describeRestoration(result)}`);
  if (result.matched === 0) {
    process.exitCode = 1;
  }
}

/**
 * `--code` or `--campaign`, whichever was given. Which of the two, and whether
 * exactly one was named, is the service's rule — one place, so the mutation and
 * this command cannot disagree about what `--code ''` means.
 */
function targetFlags(args: ParsedArgs): InviteWithdrawalRequest {
  return { code: stringFlag(args, 'code') ?? null, campaign: stringFlag(args, 'campaign') ?? null };
}

/**
 * `--grant` in USD. A malformed amount is the operator's typo, so it earns the
 * usage message rather than a stack trace.
 */
function grantOf(value: string): number {
  try {
    return usdToMicros(value, '--grant');
  } catch (error) {
    throw error instanceof InvalidMicroAmountError ? new UsageError(error.message) : error;
  }
}

/**
 * A campaign tag is read back by people and grouped on, so it is kept to the
 * shape a slug has — a stray space or capital would silently split one campaign's
 * numbers into two rows.
 */
function campaignTag(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new UsageError(
      `--campaign must be a lowercase tag such as "launch-2026-10-devs", got “${value}”. ` +
        'It is grouped on, so two spellings would be two campaigns.',
    );
  }
  return value;
}

/**
 * `2026-12-31` means "valid through the 31st", so it resolves to midnight UTC on
 * the 1st. A full ISO timestamp is taken as given.
 */
function expiryOf(value: string | undefined): Date | null {
  if (value === undefined) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const endOfDay = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(endOfDay.getTime())) {
      throw new UsageError(`--expires is not a date: “${value}”.`);
    }
    return new Date(endOfDay.getTime() + 24 * 60 * 60 * 1000);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(`--expires must be YYYY-MM-DD or an ISO timestamp, got “${value}”.`);
  }
  return parsed;
}

main().catch((error: unknown) => {
  if (error instanceof UsageError || error instanceof InviteTargetError) {
    console.error(`[invites] ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  console.error('[invites] Failed:', error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
