import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { InviteCarriedRedemption } from '../db/entities/invite-carried-redemption.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteAdminService, type InviteCodeStatus } from './invite-admin.service.js';
import { maskInviteCode } from './invite-code.js';
import {
  type InviteCodeCsvRow,
  type InviteCodeCsvRowError,
  inviteCodesCsvHeader,
  inviteCodesCsvRow,
  readInviteCodesCsv,
} from './invite-codes-csv.js';

export interface InviteCodesExportFilter {
  campaign?: string | null;
  status?: InviteCodeStatus | null;
}

export interface InviteCodesExport {
  csv: string;
  count: number;
}

/** A row the import leaves out because its code is already here, or earlier in the file. */
export interface InviteCodeImportDuplicate {
  row: number;
  /** `ABCD-••••-••••` — enough to find the row, not enough to redeem. */
  code: string;
  reason: 'already_present' | 'repeated_in_file';
}

export interface InviteCodesImportReport {
  /** SHA-256 of the file as uploaded; what `apply` is checked against. */
  sha256: string;
  /** Whether anything was written. False for a dry run and for a refused file. */
  applied: boolean;
  /** No malformed row. A file that is not ok is never written, in whole or in part. */
  ok: boolean;
  /** Data rows in the file, the header aside. */
  totalRows: number;
  /** Codes this import creates, by where each will stand once imported. */
  toCreate: Record<InviteCodeStatus, number>;
  createCount: number;
  campaigns: number;
  /** Redemptions carried over whose address already has an account here. */
  redemptionsLinked: number;
  /** Redemptions carried over as an address only. */
  redemptionsUnlinked: number;
  duplicateCount: number;
  /** The first {@link REPORT_LIST_CAP} of them. */
  duplicates: InviteCodeImportDuplicate[];
  errorCount: number;
  /** The first {@link REPORT_LIST_CAP} of them. */
  errors: InviteCodeCsvRowError[];
}

/** Rows a report lists in full; the counts beside them are always exact. */
export const REPORT_LIST_CAP = 200;

/** Codes read per page of the export, and written per `INSERT` of the import. */
const EXPORT_PAGE = 500;
const INSERT_BATCH = 100;
/** Codes per `IN`, under SQLite's 999 bound-parameter ceiling. */
const LOOKUP_CHUNK = 500;

interface Plan {
  report: InviteCodesImportReport;
  writes: InviteCodeCsvRow[];
}

/**
 * The Codes tab as a file, both ways (SUP-272): every code — or the ones a
 * filter names — out as CSV, and that CSV into another deployment.
 *
 * The export reads through {@link InviteAdminService.codes}, so the file and the
 * table can never disagree about a status or a redeemer. The import writes codes
 * with the values, terms and standing they had: a live code stays live, and a
 * redeemed or withdrawn one arrives already spent, so `claimSeat` refuses it
 * here exactly as it would have there. No credit is written and no account is
 * touched — who redeemed a code travels as an `InviteCarriedRedemption`.
 *
 * `plan` and `apply` are one computation. `apply` runs it again inside its
 * transaction and writes what it says, so the report a dry run showed is the
 * report the import returns unless the deployment changed in between — and one
 * malformed row means nothing is written at all.
 */
@Injectable()
export class InviteCodesTransferService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly admin: InviteAdminService,
  ) {}

  async export(
    filter: InviteCodesExportFilter,
    landingBaseUrl: string,
    now: Date = new Date(),
  ): Promise<InviteCodesExport> {
    let csv = inviteCodesCsvHeader();
    let count = 0;
    for (let offset = 0; ; offset += EXPORT_PAGE) {
      const page = await this.admin.codes({ ...filter, offset, limit: EXPORT_PAGE }, now);
      for (const code of page.nodes) {
        csv += inviteCodesCsvRow(code, landingBaseUrl);
      }
      count += page.nodes.length;
      if (page.nodes.length < EXPORT_PAGE) {
        return { csv, count };
      }
    }
  }

  /** The dry run: what {@link apply} would do with this file, with nothing written. */
  async plan(csv: string, now: Date = new Date()): Promise<InviteCodesImportReport> {
    return (await this.planWithin(this.dataSource.manager, csv, now)).report;
  }

  /**
   * Imports the file, or writes nothing: the plan, the codes and their carried
   * redemptions share one transaction, and a file with a malformed row is
   * returned as its report with `applied: false`.
   */
  async apply(csv: string, now: Date = new Date()): Promise<InviteCodesImportReport> {
    return this.dataSource.transaction(async (manager) => {
      const { report, writes } = await this.planWithin(manager, csv, now);
      if (!report.ok) {
        return report;
      }

      const ids = new Map(writes.map((row) => [row.code, randomUUID()]));
      for (let at = 0; at < writes.length; at += INSERT_BATCH) {
        await manager.insert(
          InviteCode,
          writes.slice(at, at + INSERT_BATCH).map((row) => ({
            id: ids.get(row.code),
            code: row.code,
            grantMicros: row.grantMicros,
            campaign: row.campaign,
            maxRedemptions: row.maxRedemptions,
            redemptionCount: row.redemptionCount,
            expiresAt: row.expiresAt,
            disabledAt: row.disabledAt,
            note: row.note,
            // Whoever minted it is an account on the other deployment; who
            // imported it is on the audit line.
            issuedByUserId: null,
            createdAt: row.createdAt,
          })),
        );
      }
      const carried = writes.flatMap((row) =>
        row.redeemers.map((redeemer) => ({
          id: randomUUID(),
          inviteCodeId: ids.get(row.code),
          email: redeemer.email,
          redeemedAt: redeemer.redeemedAt,
          importedAt: now,
        })),
      );
      for (let at = 0; at < carried.length; at += INSERT_BATCH) {
        await manager.insert(InviteCarriedRedemption, carried.slice(at, at + INSERT_BATCH));
      }
      return { ...report, applied: true };
    });
  }

  private async planWithin(manager: EntityManager, csv: string, now: Date): Promise<Plan> {
    const { rows, repeated, errors } = readInviteCodesCsv(csv, now);
    const present = await this.presentAmong(
      manager,
      rows.map((row) => row.code),
    );
    const writes = rows.filter((row) => !present.has(row.code));
    const duplicates: InviteCodeImportDuplicate[] = [
      ...rows
        .filter((row) => present.has(row.code))
        .map((row) => ({ row: row.row, code: maskInviteCode(row.code), reason: 'already_present' as const })),
      ...repeated.map((row) => ({ row: row.row, code: maskInviteCode(row.code), reason: 'repeated_in_file' as const })),
    ].sort((left, right) => left.row - right.row);

    const toCreate: Record<InviteCodeStatus, number> = { active: 0, redeemed: 0, expired: 0, withdrawn: 0 };
    for (const row of writes) {
      toCreate[row.status] += 1;
    }
    const addresses = writes.flatMap((row) =>
      row.redeemers.flatMap((redeemer) => (redeemer.email ? [redeemer.email] : [])),
    );
    const accounts = await this.admin.accountsOf(addresses);
    const redemptions = writes.reduce((sum, row) => sum + row.redeemers.length, 0);
    const linked = addresses.filter((address) => accounts.has(address)).length;

    return {
      writes,
      report: {
        sha256: createHash('sha256').update(csv, 'utf8').digest('hex'),
        applied: false,
        ok: errors.length === 0,
        totalRows: rows.length + repeated.length + errors.length,
        toCreate,
        createCount: writes.length,
        campaigns: new Set(writes.map((row) => row.campaign)).size,
        redemptionsLinked: linked,
        redemptionsUnlinked: redemptions - linked,
        duplicateCount: duplicates.length,
        duplicates: duplicates.slice(0, REPORT_LIST_CAP),
        errorCount: errors.length,
        errors: errors.slice(0, REPORT_LIST_CAP),
      },
    };
  }

  /** Which of these code values the deployment already holds. */
  private async presentAmong(manager: EntityManager, codes: readonly string[]): Promise<Set<string>> {
    const present = new Set<string>();
    for (let at = 0; at < codes.length; at += LOOKUP_CHUNK) {
      const found = await manager
        .createQueryBuilder(InviteCode, 'invite')
        .select('invite.code', 'code')
        .where('invite.code IN (:...codes)', { codes: codes.slice(at, at + LOOKUP_CHUNK) })
        .getRawMany<{ code: string }>();
      for (const row of found) {
        present.add(row.code);
      }
    }
    return present;
  }
}
