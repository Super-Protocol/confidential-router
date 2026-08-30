import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { WorkspaceScopeService } from '../auth/index.js';
import { EvidenceExportService } from './evidence-export.service.js';

/**
 * Serves the evidence archive an `exportEvidence` mutation minted a link for.
 *
 * Authenticated by the token in the URL and not by a session: the point of the
 * export is that it can be handed to an auditor. The token names the user it was
 * minted for, and membership is re-checked here — a link stays valid only while
 * the person who created it still has access.
 */
@ApiTags('exports')
@Controller('exports')
export class ExportsController {
  constructor(
    private readonly exports: EvidenceExportService,
    private readonly workspaces: WorkspaceScopeService,
  ) {}

  @Get('evidence.zip')
  @ApiOperation({ summary: 'Evidence bundles for a period, as a zip. Requires a signed export link.' })
  async evidence(@Query('token') token: string, @Res() response: Response): Promise<void> {
    const claims = this.exports.verifyToken(token ?? '');
    await this.workspaces.requireMembership(claims.userId, claims.workspaceId);

    const archive = await this.exports.build(claims.workspaceId, new Date(claims.from), new Date(claims.to));
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="evidence-${claims.workspaceId}.zip"`);
    response.setHeader('Cache-Control', 'no-store');
    response.send(archive);
  }
}
