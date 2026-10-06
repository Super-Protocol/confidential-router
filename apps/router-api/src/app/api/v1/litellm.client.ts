import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../../config.js';
import { postToUpstream } from './upstream-fetch.js';

export interface UpstreamRequest {
  /** OpenAI path, forwarded verbatim: `/v1/chat/completions` and friends. */
  path: string;
  body: unknown;
  /** Correlates the upstream's own logs with our `Generation` row. */
  generationId: string;
  stream: boolean;
  /** Aborted when the client hangs up or the read goes idle. */
  signal: AbortSignal;
}

export { UpstreamUnavailableError } from './upstream-fetch.js';

/**
 * The router's only outbound dependency *inside* the cluster: LiteLLM, over
 * plain HTTP (ADR-002 §4).
 *
 * Bodies are passed through untouched apart from `model`, which the caller has
 * already rewritten to the upstream's name. The router does not inspect
 * `messages` — not here, not anywhere.
 *
 * Models in *another* deployment do not come this way: they go out through
 * `ExternalUpstreamClient`, which is the same POST over a verifying sidecar
 * rather than a trusted cluster hop (ADR-008 §4).
 */
@Injectable()
export class LiteLlmClient {
  private readonly logger = new Logger(LiteLlmClient.name);

  constructor(@Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>) {}

  /** Longest the relay waits between upstream chunks; owned here with the rest of the backend config. */
  get readTimeoutMs(): number {
    return this.config.backends.litellm.readTimeout;
  }

  async send(request: UpstreamRequest): Promise<Response> {
    const { baseUrl, apiKey, connectTimeout } = this.config.backends.litellm;
    const url = `${baseUrl.replace(/\/+$/, '')}${request.path}`;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: request.stream ? 'text/event-stream' : 'application/json',
      'x-litellm-metadata': JSON.stringify({ generation_id: request.generationId }),
    };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    return postToUpstream({
      url,
      headers,
      body: request.body,
      connectTimeoutMs: connectTimeout,
      signal: request.signal,
      onRetry: (attempt, attempts) =>
        this.logger.warn(`LiteLLM ${url} unreachable (attempt ${attempt}/${attempts}); retrying.`),
    });
  }
}
