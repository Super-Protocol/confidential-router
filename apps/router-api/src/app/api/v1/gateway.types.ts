import type { AuthenticatedApiKey } from '../../api-keys/index.js';
import type { GenerationClient, GenerationStatus } from '../../db/entities/generation.entity.js';
import type { ModelCapability, ModelOrigin } from '../../db/entities/model.entity.js';
import type { EvidenceCoverage } from '../../metering/evidence-coverage.service.js';

/**
 * Where the OpenAI-compatible surface lives, as a mount prefix.
 *
 * Shared because two things outside the controllers key off it: the body parser
 * `configureApp` gives `/v1` its own, larger limit, and the middleware that turns
 * a parser refusal on this prefix into an OpenAI-shaped error rather than Nest's.
 */
export const V1_BASE_PATH = '/v1';

/** Which OpenAI route is being served; decides the upstream path and the shaping. */
export type RouteKind = 'chat' | 'completions' | 'embeddings';

export const UPSTREAM_PATHS: Record<RouteKind, string> = {
  chat: '/v1/chat/completions',
  completions: '/v1/completions',
  embeddings: '/v1/embeddings',
};

/**
 * The endpoint a request is attributed to, as the `/v1` surface reports it.
 *
 * One shape for both origins on purpose: `usage.endpoint`, the
 * `X-Confidential-Router-Endpoint` header and `GET /v1/models` name an endpoint
 * the same way whether it is a hostname this deployment publishes evidence for or
 * one it verified itself. `id` is the primary key of whichever table owns it —
 * `endpoints` or `external_endpoints` — and {@link RoutedModel.external} is what
 * tells them apart.
 */
export interface RoutedEndpoint {
  id: string;
  name: string;
  hostname: string;
}

/**
 * What the egress leg needs to reach an upstream in someone else's deployment
 * (ADR-008 §4).
 *
 * The base URL is the sidecar's loopback listener, not the upstream's hostname:
 * router-api never dials an external host itself, because the pinned-certificate
 * handshake that makes the channel trustworthy happens in the sidecar. The key is
 * carried as its sealed envelope and opened one request at a time — the sidecar
 * passes `Authorization` through untouched and holds no secret of its own.
 */
export interface ExternalRoute {
  /** `http://127.0.0.1:<listenPort>` — the sidecar's listener for this endpoint. */
  baseUrl: string;
  /** The sealed upstream API key; opened by the egress leg, never logged or stored. */
  apiKeyCiphertext: string;
  /** Upstream snapshot digest from the verdict that admitted this endpoint. */
  evidenceDigestSeen: string | null;
  /** Normalised mrEnclave hex the admitting verdict observed. */
  measurementSeen: string | null;
}

/**
 * A model admission resolved, with everything the forwarding path needs and
 * nothing about where it came from beyond {@link external}.
 *
 * The two catalogues — the boot-projected config one and the admin-managed
 * external one — both resolve into this, which is what keeps rate limits,
 * metering, SSE relay and response shaping one code path for both (ADR-008 §4:
 * everything above the seam is identical, the seam is the forward target).
 */
export interface RoutedModel {
  id: string;
  name: string;
  /** The name the *upstream* knows this model by; the body's `model` is rewritten to it. */
  upstreamModel: string;
  contextLength: number;
  capabilities: ModelCapability[];
  promptPer1mMicros: number;
  completionPer1mMicros: number;
  origin: ModelOrigin;
  endpoint: RoutedEndpoint;
  /** Set iff `origin === 'external'`. Null is the LiteLLM leg. */
  external: ExternalRoute | null;
  /** When this row was last written; surfaced as OpenAI's `created`. */
  updatedAt: Date;
}

/** Everything admission resolved, carried through dispatch and into the meter. */
export interface GatewayContext {
  kind: RouteKind;
  generationId: string;
  model: RoutedModel;
  auth: AuthenticatedApiKey;
  /**
   * The body the upstream will receive, bar the `model` rewrite the forwarding
   * path applies: the client's own, or — for a bridged legacy completions
   * request ({@link bridged}) — the chat body translated from it. Never stored.
   */
  body: Record<string, unknown>;
  stream: boolean;
  /**
   * The upstream path this request is forwarded to. Normally
   * `UPSTREAM_PATHS[kind]`; the chat one for a legacy completions request the
   * router serves by translation ({@link bridged}).
   */
  upstreamPath: string;
  /**
   * True when `POST /v1/completions` is being served by wrapping the prompt in a
   * chat request (`completions-bridge.ts`, SUP-450). The forwarding path, the
   * relay and the meter are told nothing else about it: the translation happens
   * on the way in and on the way out, and this flag is what the two edges read.
   */
  bridged: boolean;
  /**
   * True when the router asked the backend for a usage chunk the client did
   * not: the meter needs the real counts, the client asked for a stream that
   * does not contain them, so the chunk is recorded and dropped.
   */
  suppressUsageChunk: boolean;
  /**
   * What the platform published for a *config* endpoint at request time, or null.
   * Always null for an external model: there is no snapshot row behind an
   * upstream's bundle, and what covers that request is a verdict — see
   * {@link evidenceDigest}.
   */
  coverage: EvidenceCoverage | null;
  /**
   * The digest reported as `usage.evidence_digest`: the published snapshot's for a
   * config model, the digest the admitting verdict observed for an external one.
   */
  evidenceDigest: string | null;
  rateLimitHeaders: Record<string, string>;
  requestId: string | null;
  clientIp: string | null;
  /**
   * Which client sent this request, derived once on the way in (SUP-466).
   *
   * On the context rather than re-read in the recorder, so the error and abort
   * paths — which have no request object left to look at — meter the same label
   * as the success path. The headers it came from are not carried any further;
   * see `client-dimension.ts`.
   */
  client: GenerationClient;
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
