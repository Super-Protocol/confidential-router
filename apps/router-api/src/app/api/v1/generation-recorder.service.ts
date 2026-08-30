import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../../config.js';
import type { EvidenceCoverage } from '../../metering/evidence-coverage.service.js';
import { EvidenceCoverageService } from '../../metering/evidence-coverage.service.js';
import { MeteringService } from '../../metering/metering.service.js';
import { computeCostMicros, tokensPerSecond } from '../../metering/pricing.js';
import { generationId } from '../../metering/ulid.js';
import type { GatewayContext, GenerationOutcome } from './gateway.types.js';

export interface GenerationStart {
  id: string;
  coverage: EvidenceCoverage | null;
}

/**
 * Opens and closes the metering record around one request.
 *
 * `begin` runs before anything is forwarded, because the evidence coverage that
 * belongs on the row is the one that was current *then* — resolving it
 * afterwards would attribute a later snapshot to an earlier generation.
 */
@Injectable()
export class GenerationRecorder {
  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly evidence: EvidenceCoverageService,
    private readonly metering: MeteringService,
  ) {}

  async begin(endpointId: string): Promise<GenerationStart> {
    return { id: generationId(), coverage: await this.evidence.currentFor(endpointId) };
  }

  async finish(context: GatewayContext, outcome: GenerationOutcome): Promise<void> {
    const latencyMs = Date.now() - context.startedAt;
    const generationMs = outcome.timeToFirstTokenMs === null ? latencyMs : latencyMs - outcome.timeToFirstTokenMs;
    await this.metering.record({
      id: context.generationId,
      workspaceId: context.auth.workspace.id,
      apiKeyId: context.auth.key.id,
      modelId: context.model.id,
      endpointId: context.model.endpoint.id,
      evidenceSnapshotId: context.coverage?.snapshotId ?? null,
      evidenceDigest: context.coverage?.evidenceDigest ?? null,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      costMicros: computeCostMicros(outcome, context.model),
      promptPer1mMicros: context.model.promptPer1mMicros,
      completionPer1mMicros: context.model.completionPer1mMicros,
      streamed: context.stream,
      status: outcome.status,
      errorCode: outcome.errorCode,
      finishReason: outcome.finishReason,
      latencyMs,
      timeToFirstTokenMs: outcome.timeToFirstTokenMs,
      tokensPerSecond: tokensPerSecond(outcome.completionTokens, generationMs),
      requestId: context.requestId,
      clientIpHash: this.hashClientIp(context.clientIp),
      createdAt: new Date(context.startedAt),
    });
  }

  /**
   * Salted with the deployment's auth secret so the column cannot be reversed
   * with a rainbow table of the IPv4 space. The address itself never lands.
   */
  private hashClientIp(ip: string | null): string | null {
    if (!ip) {
      return null;
    }
    return createHash('sha256').update(`${this.config.auth.secret}:${ip}`).digest('hex').slice(0, 64);
  }
}
