import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, SessionGuard, type SessionUser, WorkspaceScopeService } from '../auth/index.js';
import { GenerationCsvQueryDto } from './activity.dto.js';
import { csvRow } from './csv.js';
import { GenerationLogService } from './generation-log.service.js';

const CSV_HEADER = [
  'id',
  'createdAt',
  'modelId',
  'endpointId',
  'apiKeyId',
  'status',
  'finishReason',
  'promptTokens',
  'completionTokens',
  'costMicros',
  'latencyMs',
  'timeToFirstTokenMs',
  'tokensPerSecond',
  'streamed',
  'evidenceDigest',
] as const;

/**
 * The CSV half of the Logs screen.
 *
 * REST and not GraphQL because a download is a browser navigation with a
 * filename and a content type, which a GraphQL response cannot be. It carries
 * the session cookie the console already has — the export is the same data the
 * `generations` query returns, so it needs no authority the console lacks.
 */
@ApiTags('activity')
@Controller('activity')
export class ActivityController {
  constructor(
    private readonly logs: GenerationLogService,
    private readonly workspaces: WorkspaceScopeService,
  ) {}

  @Get('generations.csv')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Generation log as CSV, oldest first.' })
  async generationsCsv(
    @CurrentUser() user: SessionUser,
    @Query() query: GenerationCsvQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    await this.workspaces.requireMembership(user.id, query.workspaceId);

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="generations-${query.workspaceId}.csv"`);
    // Nothing downstream may cache a per-workspace export.
    response.setHeader('Cache-Control', 'no-store');
    response.write(csvRow([...CSV_HEADER]));

    const chunks = this.logs.exportCsv({
      workspaceId: query.workspaceId,
      filter: {
        from: query.from ? new Date(query.from) : null,
        to: query.to ? new Date(query.to) : null,
        modelIds: query.modelIds ?? null,
        apiKeyIds: query.apiKeyIds ?? null,
        statuses: query.status ?? null,
      },
    });

    for await (const rows of chunks) {
      for (const generation of rows) {
        response.write(
          csvRow([
            generation.id,
            generation.createdAt.toISOString(),
            generation.modelId,
            generation.endpointId,
            generation.apiKeyId,
            generation.status,
            generation.finishReason,
            generation.promptTokens,
            generation.completionTokens,
            generation.costMicros,
            generation.latencyMs,
            generation.timeToFirstTokenMs,
            generation.tokensPerSecond,
            generation.streamed ? 'true' : 'false',
            generation.evidenceDigest,
          ]),
        );
      }
    }
    response.end();
  }
}
