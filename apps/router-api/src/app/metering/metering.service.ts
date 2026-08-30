import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiKeyService } from '../api-keys/api-key.service.js';
import { Generation, type GenerationStatus } from '../db/entities/generation.entity.js';
import { CREDITS_GATEWAY, type CreditsGateway } from './credits.gateway.js';

/**
 * Everything the router knows about one served request. No prompt, no
 * completion, no headers — `data-model.md` invariant 1, enforced by
 * `invariants.spec.ts`.
 */
export interface MeteringRecord {
  id: string;
  workspaceId: string;
  apiKeyId: string;
  modelId: string;
  endpointId: string;
  evidenceSnapshotId: string | null;
  evidenceDigest: string | null;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  promptPer1mMicros: number;
  completionPer1mMicros: number;
  streamed: boolean;
  status: GenerationStatus;
  errorCode: string | null;
  finishReason: string | null;
  latencyMs: number;
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;
  requestId: string | null;
  clientIpHash: string | null;
  createdAt: Date;
}

/**
 * Writes the meter for a finished request.
 *
 * Called from the gateway's completion path — including the error and abort
 * paths, because a request that consumed tokens before failing still consumed
 * them. Failures here are logged and swallowed: the response has already been
 * sent (or is mid-flight), and losing a metering row is better than turning a
 * served generation into a 500.
 */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CREDITS_GATEWAY) private readonly credits: CreditsGateway,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async record(record: MeteringRecord): Promise<void> {
    try {
      await this.dataSource.getRepository(Generation).insert(record);
      await this.apiKeys.recordSpend(record.apiKeyId, record.costMicros);
      await this.credits.debit({
        workspaceId: record.workspaceId,
        generationId: record.id,
        amountMicros: record.costMicros,
      });
    } catch (error) {
      this.logger.error(
        `Failed to meter generation ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
