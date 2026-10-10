import { BadRequestException, Controller, Get, HttpCode, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AdminGuard, CurrentUser, SessionGuard, type SessionUser } from '../auth/index.js';
import { DataExportService } from './data-export.service.js';
import { DataImportService, type ImportReport } from './data-import.service.js';
import { BundleRefusedError, type ExportBundle, encodeBundle } from './export-bundle.js';

/** Mounted with a raw body parser of its own in `configureApp`: the upload is a gzip file, not JSON. */
export const DATA_IMPORT_PATH = '/admin/data/import';
export const DATA_EXPORT_CONTENT_TYPE = 'application/gzip';

/**
 * The deployment export and its import (SUP-271) — the way a small production
 * dataset survives a redeploy.
 *
 * REST and not GraphQL because both ends are a file: a download the browser
 * saves, and an upload of the same bytes. Authenticated by the operator's own
 * session and `auth.adminEmails`, never by a link — unlike the evidence export
 * this file is not for handing on, it holds personal data and live invitation
 * codes, so there is no URL that carries the authority to fetch it. The upload's
 * content type is not one a cross-site form can send, so the browser's preflight
 * is what stands between another origin and this route.
 *
 * Both actions leave an audit line naming the operator, the bundle's hash and
 * its row counts. Neither logs a row: no address, no code.
 */
@ApiTags('admin')
@Controller('admin/data')
@UseGuards(SessionGuard, AdminGuard)
export class DataMigrationController {
  private readonly logger = new Logger(DataMigrationController.name);

  constructor(
    private readonly exports: DataExportService,
    private readonly imports: DataImportService,
  ) {}

  @Get('export')
  @ApiOperation({ summary: 'The deployment export, as a gzipped JSON document. Restricted to auth.adminEmails.' })
  async export(@CurrentUser() user: SessionUser, @Res() response: Response): Promise<void> {
    const bundle = await this.exports.export();
    this.logger.warn(`Deployment export downloaded by ${user.email} — ${summaryOf(bundle)}.`);

    response.setHeader('Content-Type', DATA_EXPORT_CONTENT_TYPE);
    response.setHeader('Content-Disposition', `attachment; filename="${fileNameOf(bundle)}"`);
    response.setHeader('Cache-Control', 'no-store');
    // Read by the console across origins, to name the file and show its hash.
    response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Sha256');
    response.setHeader('X-Export-Sha256', bundle.integrity.contentSha256);
    response.send(encodeBundle(bundle));
  }

  /**
   * A dry run unless `apply=true`. With `apply`, `expect` must be the hash the
   * dry run reported, so what goes in is the file that was looked at — not a
   * second file picked by mistake between the two clicks.
   */
  @Post('import')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dry-runs or applies a deployment export. Restricted to auth.adminEmails.' })
  async import(@CurrentUser() user: SessionUser, @Req() request: Request): Promise<ImportReport> {
    const { apply, expect } = request.query;
    const file: unknown = request.body;
    if (!Buffer.isBuffer(file)) {
      throw new BadRequestException(
        `Send the export file as the request body, with Content-Type ${DATA_EXPORT_CONTENT_TYPE}.`,
      );
    }

    try {
      if (apply !== 'true') {
        const report = await this.imports.plan(file);
        this.logger.warn(`Deployment import dry run by ${user.email} — ${outcomeOf(report)}.`);
        return report;
      }

      const preview = await this.imports.plan(file);
      if (!expect || expect !== preview.contentSha256) {
        throw new BadRequestException(
          'This is not the file the dry run looked at. Run the dry run again, then import.',
        );
      }
      const report = await this.imports.apply(file);
      this.logger.warn(`Deployment import by ${user.email} — ${outcomeOf(report)}.`);
      return report;
    } catch (error) {
      if (error instanceof BundleRefusedError) {
        this.logger.warn(`Deployment import by ${user.email} refused — ${error.message}`);
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

function fileNameOf(bundle: ExportBundle): string {
  const stamp = bundle.exportedAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  let host = 'router';
  try {
    host = new URL(bundle.source.publicBaseUrl).hostname.replace(/[^a-z0-9.-]/gi, '') || host;
  } catch {
    // An unparseable base URL names the file generically; it is still the same export.
  }
  return `router-export-${stamp}-${host}.json.gz`;
}

function summaryOf(bundle: Pick<ExportBundle, 'counts'> & { integrity: { contentSha256: string } }): string {
  const { counts } = bundle;
  return (
    `sha256 ${bundle.integrity.contentSha256}: ${counts.users} account(s), ${counts.workspaces} workspace(s), ` +
    `${counts.creditEntries} ledger entr(y/ies), ${counts.inviteCodes} invitation code(s) ` +
    `(${counts.inviteCodesUnredeemed} unredeemed), ${counts.externalEndpoints} external endpoint(s), ` +
    `${counts.trustedMeasurements} trusted measurement(s)`
  );
}

function outcomeOf(report: ImportReport): string {
  const created = report.sections.map((section) => `${section.section} +${section.toCreate}`).join(', ');
  const conflicts = report.sections.reduce((sum, section) => sum + section.conflicts.length, 0);
  const verdict = report.applied
    ? 'applied'
    : report.ok
      ? 'clean, nothing written'
      : `refused (${report.refusals.length} refusal(s), ${conflicts} conflict(s)), nothing written`;
  return `${verdict}; from ${report.source.publicBaseUrl}, sha256 ${report.contentSha256}: ${created}`;
}
