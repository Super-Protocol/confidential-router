import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AdminGuard, CurrentUser, SessionGuard, type SessionUser } from '../../auth/index.js';
import { isUniqueViolation } from '../../billing/index.js';
import { routerConfig } from '../../config.js';
import {
  InviteCodesCsvRefusedError,
  type InviteCodesImportReport,
  InviteCodesTransferService,
} from '../../invites/index.js';
import { InviteCodesExportQueryDto, InviteCodesImportQueryDto } from './invite-codes-csv.dto.js';

/** Mounted with a text body parser of its own in `configureApp`: the upload is the CSV file, not JSON. */
export const INVITE_CODES_IMPORT_PATH = '/admin/invite-codes/import';
export const INVITE_CODES_CSV_CONTENT_TYPE = 'text/csv';
/** Fifty thousand rows of this export are about 12 MB. */
export const MAX_INVITE_CODES_CSV_BYTES = 16 * 1024 * 1024;

/**
 * The Codes tab as a file (SUP-272): export every code, or the ones the tab's
 * filter names, and import that file into another deployment.
 *
 * REST and not GraphQL because both ends are a file — a download the browser
 * saves under a name, and an upload of the same bytes. Authorised by the
 * operator's own session and `auth.adminEmails`, exactly as issuing is: the file
 * holds live codes, each one bearer credit. The upload's content type is not one
 * a cross-site form can send, so a browser preflights it and CORS is what stands
 * between another origin and this route.
 *
 * Every action leaves an audit line naming the operator and the counts. **None
 * logs a code** — a refused row is named by its row number, a duplicate by the
 * masked form the rest of the audit log uses.
 */
@ApiTags('admin')
@Controller('admin/invite-codes')
@UseGuards(SessionGuard, AdminGuard)
export class InviteCodesCsvController {
  private readonly logger = new Logger(InviteCodesCsvController.name);

  constructor(
    private readonly transfer: InviteCodesTransferService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  @Get('export.csv')
  @ApiOperation({ summary: 'Invitation codes as CSV, newest first. Restricted to auth.adminEmails.' })
  async export(
    @CurrentUser() user: SessionUser,
    @Query() query: InviteCodesExportQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const filter = { campaign: query.campaign ?? null, status: query.status ?? null };
    const { csv, count } = await this.transfer.export(filter, this.config.invites.landingBaseUrl);
    this.logger.warn(
      `Invitation codes exported by ${user.email} — ${count} code(s), ` +
        `${filter.campaign ? `campaign “${filter.campaign}”` : 'every campaign'}, ${filter.status ?? 'any'} status.`,
    );

    const scope = [filter.campaign, filter.status].filter(Boolean).join('-') || 'all';
    response.setHeader('Content-Type', `${INVITE_CODES_CSV_CONTENT_TYPE}; charset=utf-8`);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="invite-codes-${scope}-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    // A file of live codes must not be kept by anything between here and the operator.
    response.setHeader('Cache-Control', 'no-store');
    response.send(csv);
  }

  /**
   * A dry run unless `apply=true`. With `apply`, `expect` must be the hash the
   * dry run reported, so what goes in is the file that was looked at — not a
   * second file picked by mistake between the two clicks.
   */
  @Post('import')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dry-runs or applies an invitation codes CSV. Restricted to auth.adminEmails.' })
  async import(
    @CurrentUser() user: SessionUser,
    @Req() request: Request,
    @Query() { apply, expect }: InviteCodesImportQueryDto,
  ): Promise<InviteCodesImportReport> {
    const file: unknown = request.body;
    if (typeof file !== 'string') {
      throw new BadRequestException(
        `Send the CSV file as the request body, with Content-Type ${INVITE_CODES_CSV_CONTENT_TYPE}.`,
      );
    }

    try {
      if (apply !== 'true') {
        const report = await this.transfer.plan(file);
        this.logger.warn(`Invitation codes import dry run by ${user.email} — ${outcomeOf(report)}.`);
        return report;
      }

      const preview = await this.transfer.plan(file);
      if (!expect || expect !== preview.sha256) {
        throw new BadRequestException(
          'This is not the file the dry run looked at. Run the dry run again, then import.',
        );
      }
      const report = await this.transfer.apply(file);
      this.logger.warn(`Invitation codes import by ${user.email} — ${outcomeOf(report)}.`);
      return report;
    } catch (error) {
      if (error instanceof InviteCodesCsvRefusedError) {
        this.logger.warn(`Invitation codes import by ${user.email} refused — ${error.message}`);
        throw new BadRequestException(error.message);
      }
      // A code minted or imported between the plan and the insert: the
      // transaction is rolled back, so nothing of this file was written.
      if (isUniqueViolation(error)) {
        this.logger.warn(`Invitation codes import by ${user.email} rolled back — the codes changed underneath it.`);
        throw new ConflictException(
          'The codes on this deployment changed during the import. Nothing was written; run it again.',
        );
      }
      throw error;
    }
  }
}

function outcomeOf(report: InviteCodesImportReport): string {
  const { toCreate } = report;
  const verdict = report.applied
    ? 'applied'
    : report.ok
      ? 'clean, nothing written'
      : `refused (${report.errorCount} malformed row(s)), nothing written`;
  return (
    `${verdict}; sha256 ${report.sha256}: ${report.totalRows} row(s), +${report.createCount} code(s) ` +
    `(${toCreate.active} unredeemed, ${toCreate.redeemed} redeemed, ${toCreate.expired} expired, ` +
    `${toCreate.withdrawn} withdrawn) across ${report.campaigns} campaign(s), ${report.duplicateCount} duplicate(s) skipped`
  );
}
