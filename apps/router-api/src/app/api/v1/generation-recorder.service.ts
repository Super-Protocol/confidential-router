import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { saltedHash } from '../../common/salted-hash.js';
import { routerConfig } from '../../config.js';
import type { EvidenceCoverage } from '../../metering/evidence-coverage.service.js';
import { EvidenceCoverageService } from '../../metering/evidence-coverage.service.js';
import { MeteringService } from '../../metering/metering.service.js';
import { computeCostMicros, tokensPerSecond } from '../../metering/pricing.js';
import { generationId } from '../../metering/ulid.js';
import type { GatewayContext, GenerationOutcome, RoutedModel } from './gateway.types.js';

export interface GenerationStart {
  id: string;
  /** The published snapshot behind a config endpoint; always null for an external one. */
  coverage: EvidenceCoverage | null;
  /** What `usage.evidence_digest` and the metering row report. */
  evidenceDigest: string | null;
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

  /**
   * What covers this request, resolved before it is forwarded.
   *
   * The two origins answer "which evidence covered this generation?" with
   * different kinds of fact, and ADR-008 §4 is explicit that the external answer
   * is the stronger one. A config endpoint gets *coverage*: the platform had
   * published a fresh bundle, which is all ADR-002 lets this router record about
   * itself. An external endpoint gets the digest a **verdict** observed — the
   * router verified that bundle itself — and no `evidence_snapshots` row, because
   * there is none to point at until the external evidence poll lands.
   */
  async begin(model: RoutedModel): Promise<GenerationStart> {
    if (model.external) {
      return { id: generationId(), coverage: null, evidenceDigest: model.external.evidenceDigestSeen };
    }
    const coverage = await this.evidence.currentFor(model.endpoint.id);
    return { id: generationId(), coverage, evidenceDigest: coverage?.evidenceDigest ?? null };
  }

  async finish(context: GatewayContext, outcome: GenerationOutcome): Promise<void> {
    const latencyMs = Date.now() - context.startedAt;
    const generationMs = outcome.timeToFirstTokenMs === null ? latencyMs : latencyMs - outcome.timeToFirstTokenMs;
    await this.metering.record({
      id: context.generationId,
      workspaceId: context.auth.workspace.id,
      apiKeyId: context.auth.key.id,
      modelId: context.model.id,
      // Exactly one of the two, the same exclusivity `models` carries: an external
      // generation has no `endpoints` row to point at, and pointing it at one
      // would put another operator's traffic into this deployment's own endpoint
      // totals (ADR-008 §6).
      endpointId: context.model.external ? null : context.model.endpoint.id,
      externalEndpointId: context.model.external ? context.model.endpoint.id : null,
      evidenceSnapshotId: context.coverage?.snapshotId ?? null,
      evidenceDigest: context.evidenceDigest,
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
    return ip ? saltedHash(this.config.auth.secret, ip) : null;
  }
}
