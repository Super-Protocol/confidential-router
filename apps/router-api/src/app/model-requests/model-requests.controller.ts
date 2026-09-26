import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { csvRow } from '../activity/csv.js';
import { AdminGuard, SessionGuard } from '../auth/index.js';
import { ModelDemandCsvQueryDto } from './model-requests.dto.js';
import { ModelRequestsService } from './model-requests.service.js';

const CSV_HEADER = [
  'model',
  'normalisedModel',
  'requests',
  'requesters',
  'notifyRequests',
  'firstRequestedAt',
  'lastRequestedAt',
] as const;

/**
 * The demand table as a spreadsheet.
 *
 * REST and not GraphQL for the reason the generation log's export is: a
 * download is a browser navigation with a filename and a content type, which a
 * GraphQL response cannot be. It answers the same aggregation as
 * `modelDemand`, behind the same two guards — `auth.adminEmails` only, because
 * this is every model every account has ever asked for and no tenant owns it.
 *
 * Aggregated and not one row per request: the raw table carries free text a
 * requester typed, and the thing to act on is the count. Reading a note means
 * opening the database, deliberately.
 */
@ApiTags('model-requests')
@Controller('admin/model-requests')
export class ModelRequestsController {
  constructor(private readonly requests: ModelRequestsService) {}

  @Get('demand.csv')
  @UseGuards(SessionGuard, AdminGuard)
  @ApiOperation({ summary: 'Model demand as CSV, most requested first. Restricted to auth.adminEmails.' })
  async demandCsv(@Query() query: ModelDemandCsvQueryDto, @Res() response: Response): Promise<void> {
    const demand = await this.requests.demand({
      since: query.since ? new Date(query.since) : null,
      limit: query.limit ?? null,
    });

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="model-demand.csv"');
    // Nothing downstream may cache an operator-only export.
    response.setHeader('Cache-Control', 'no-store');

    response.write(csvRow([...CSV_HEADER]));
    for (const row of demand) {
      response.write(
        csvRow([
          row.requestedModel,
          row.normalisedModel,
          row.requests,
          row.requesters,
          row.notifyRequests,
          row.firstRequestedAt.toISOString(),
          row.lastRequestedAt.toISOString(),
        ]),
      );
    }
    response.end();
  }
}
