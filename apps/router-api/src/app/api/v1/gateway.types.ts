import type { AuthenticatedApiKey } from '../../api-keys/index.js';
import type { CatalogModel } from '../../catalog/catalog.service.js';
import type { GenerationStatus } from '../../db/entities/generation.entity.js';
import type { EvidenceCoverage } from '../../metering/evidence-coverage.service.js';

/** Which OpenAI route is being served; decides the upstream path and the shaping. */
export type RouteKind = 'chat' | 'completions' | 'embeddings';

export const UPSTREAM_PATHS: Record<RouteKind, string> = {
  chat: '/v1/chat/completions',
  completions: '/v1/completions',
  embeddings: '/v1/embeddings',
};

/** Everything admission resolved, carried through dispatch and into the meter. */
export interface GatewayContext {
  kind: RouteKind;
  generationId: string;
  model: CatalogModel;
  auth: AuthenticatedApiKey;
  /** The client's body, forwarded with only `model` rewritten. Never stored. */
  body: Record<string, unknown>;
  stream: boolean;
  /**
   * True when the router asked the backend for a usage chunk the client did
   * not: the meter needs the real counts, the client asked for a stream that
   * does not contain them, so the chunk is recorded and dropped.
   */
  suppressUsageChunk: boolean;
  /** What the platform published for the endpoint at request time, or null. */
  coverage: EvidenceCoverage | null;
  rateLimitHeaders: Record<string, string>;
  requestId: string | null;
  clientIp: string | null;
  startedAt: number;
}

/** What actually happened, as far as the meter is concerned. */
export interface GenerationOutcome {
  promptTokens: number;
  completionTokens: number;
  status: GenerationStatus;
  errorCode: string | null;
  finishReason: string | null;
  timeToFirstTokenMs: number | null;
}
