import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../../config.js';
import { fetchSidecarVerdicts } from '../../external-endpoints/index.js';
import { SecretEnvelopeService } from '../../secrets/index.js';
import type { ExternalRoute, RoutedModel } from './gateway.types.js';
import { OpenAiApiError, openAiErrors } from './openai-error.js';
import type { StreamFailure } from './stream-relay.js';
import { postToUpstream } from './upstream-fetch.js';

export interface ExternalUpstreamRequest {
  /** The model being served; its endpoint id is the envelope's AAD context. */
  model: RoutedModel & { external: ExternalRoute };
  /** OpenAI path, forwarded verbatim: `/v1/chat/completions` and friends. */
  path: string;
  body: unknown;
  stream: boolean;
  /** Aborted when the client hangs up or the read goes idle. */
  signal: AbortSignal;
}

/**
 * The external egress leg: router-api → the attesting sidecar → an upstream in
 * someone else's deployment (ADR-008 §4).
 *
 * Three things make this different from {@link LiteLlmClient}, and they are the
 * whole of the difference:
 *
 * 1. **The address is loopback, the destination is not.** router-api posts to
 *    `http://127.0.0.1:<listenPort>`; the sidecar dials the upstream over TLS
 *    verified against the pinned leaf and nothing else. router-api never holds a
 *    certificate, a CA bundle or an upstream hostname resolution of its own.
 * 2. **router-api injects the credential.** The upstream API key is sealed in
 *    `external_endpoints` and opened here, one request at a time; the sidecar
 *    passes `Authorization` through untouched and never sees it as config
 *    (ADR-003 §8). That is also why nothing in this file logs a header.
 * 3. **A refusal is policy, not weather.** The sidecar answers fail-closed 503
 *    with a `gatekeeper_error` body when it holds no verdict, and closes
 *    in-flight connections when a verdict is withdrawn. Both are mapped to the
 *    router's own 503 vocabulary rather than to `backend_unavailable`, because a
 *    client that retries a busy backend should not retry an attestation failure.
 *
 * No generation-correlation header goes out. LiteLLM gets one because it is in
 * this cluster space and its logs are ours; another operator's logs are not, and
 * handing them an id that joins their requests to our users is the opposite of
 * what this leg is for.
 */
@Injectable()
export class ExternalUpstreamClient {
  private readonly logger = new Logger(ExternalUpstreamClient.name);

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly secrets: SecretEnvelopeService,
  ) {}

  /** Longest the relay waits between chunks from an external upstream. */
  get readTimeoutMs(): number {
    return this.config.externalEndpoints.readTimeout;
  }

  async send(request: ExternalUpstreamRequest): Promise<Response> {
    const { endpoint, external } = request.model;
    const url = `${external.baseUrl.replace(/\/+$/, '')}${request.path}`;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: request.stream ? 'text/event-stream' : 'application/json',
      authorization: `Bearer ${this.openKey(endpoint.id, endpoint.name, external.apiKeyCiphertext)}`,
    };

    return postToUpstream({
      url,
      headers,
      body: request.body,
      connectTimeoutMs: this.config.externalEndpoints.connectTimeout,
      signal: request.signal,
      onRetry: (attempt, attempts) =>
        // The address, never the key: this line goes to the same log an operator
        // reads, and `url` is a loopback port.
        this.logger.warn(
          `The egress sidecar listener for "${endpoint.name}" (${url}) did not accept the connection ` +
            `(attempt ${attempt}/${attempts}); retrying.`,
        ),
    });
  }

  /**
   * Opens the stored upstream credential, or fails as the router's own fault.
   *
   * `CR_API_SECRETS_KEY` unset, malformed, or rotated since this row was written
   * are all the same thing from here: an operator problem on a request that has
   * done nothing wrong. The reason goes to the log — the envelope module pins
   * that no plaintext and no key ever reach a message — and the caller gets the
   * generic 500, because a bearer token must not buy a description of this
   * deployment's secret configuration.
   */
  private openKey(endpointId: string, endpointName: string, ciphertext: string): string {
    try {
      return this.secrets.open(ciphertext, endpointId);
    } catch (error) {
      this.logger.error(
        `Cannot open the stored upstream API key for external endpoint "${endpointName}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw openAiErrors.internal();
    }
  }

  /**
   * Maps a non-2xx answer from the egress leg onto the router's error table.
   *
   * The 503 the sidecar writes when it holds no verdict (`writeDenial` in
   * `pkg/proxy/handler.go`) carries `error.type: "gatekeeper_error"` plus `stage`
   * and `reason` — and that is the one upstream body this leg forwards the wording
   * of, because unlike a cluster-internal LiteLLM message it is *about the client's
   * request being refused* and names which check refused it.
   *
   * Everything else is read as conservatively as the LiteLLM mapping: a 4xx the
   * upstream raised about its own key is not the caller's fault to hear about.
   */
  async mapFailure(model: RoutedModel, upstream: Response): Promise<OpenAiApiError> {
    const detail = await readBody(upstream);
    const denial = gatekeeperDenialOf(upstream.status, detail.parsed);
    if (denial) {
      this.logger.warn(
        `The egress sidecar refused "${model.endpoint.name}" at stage ${denial.stage}: ${denial.reason}.`,
      );
      return openAiErrors.attestationFailed(
        `The router has no valid attestation for the endpoint serving model "${model.id}" ` +
          `(${denial.stage}: ${denial.reason}). Nothing was sent to it.`,
      );
    }

    this.logger.warn(`External endpoint "${model.endpoint.name}" answered ${upstream.status}: ${detail.text || '—'}.`);
    if (upstream.status === 429) {
      const retryAfter = upstream.headers.get('retry-after') ?? '1';
      return openAiErrors.rateLimited('The external model endpoint is at capacity.', { 'Retry-After': retryAfter });
    }
    if (/context[ _-]?length|maximum context|too many tokens/i.test(detail.text)) {
      return openAiErrors.contextLengthExceeded(detail.text);
    }
    if (upstream.status >= 500 || upstream.status === 404) {
      return openAiErrors.backendUnavailable(`The external model endpoint answered ${upstream.status}.`);
    }
    return openAiErrors.backendError(`The external model endpoint rejected the request (${upstream.status}).`);
  }

  /**
   * Why an external stream died mid-flight, by asking the only party that knows.
   *
   * A withdrawn verdict takes the connection down under fail-closed
   * (`applyVerdict` → `closeAll` in `pkg/proxy/endpoint.go`), and on the wire that
   * is indistinguishable from an upstream crash: the response was a 200 long ago,
   * so there is no status code left to carry the reason. The sidecar's `/verdicts`
   * is where the reason still exists, and this is the one place that reads it
   * outside the status poll — on a failure path, over loopback, bounded by the
   * client's own timeout.
   *
   * Three answers, and the third is deliberate: if the sidecar cannot be reached
   * we do **not** report a revocation. The stream is already dead either way, so
   * nothing is admitted by guessing — and naming a policy decision that may not
   * have happened would be the same lie in the other direction.
   */
  async classifyStreamFailure(model: RoutedModel, failure: unknown): Promise<StreamFailure> {
    const name = model.endpoint.name;
    try {
      const verdicts = await fetchSidecarVerdicts(this.config.externalEndpoints.adminListen);
      const verdict = verdicts.find((candidate) => candidate.endpoint === name);
      if (verdict && !verdict.admitted) {
        const reason = verdict.reason ?? verdict.report?.reason ?? 'the endpoint is no longer admitted';
        const stage = verdict.report?.stage ?? 'policy';
        return {
          // `aborted`, not `error`: the generation was admitted and running, and
          // what ended it was a decision about the upstream rather than a fault in
          // it. Denis's ruling 5 — metered as an abort, named as policy.
          status: 'aborted',
          error: openAiErrors.attestationRevoked(
            `The attestation of the endpoint serving model "${model.id}" was withdrawn while this generation was ` +
              `streaming (${stage}: ${reason}); the connection was closed. Tokens already delivered are metered.`,
          ),
        };
      }
    } catch (error) {
      this.logger.warn(
        `Could not ask the egress sidecar why the stream from "${name}" ended: ` +
          `${error instanceof Error ? error.message : String(error)}. Reporting it as an upstream failure.`,
      );
    }
    return { status: 'error', error: asUpstreamFailure(failure) };
  }
}

/** The sidecar's fail-closed denial, or null for any other non-2xx. */
function gatekeeperDenialOf(status: number, parsed: unknown): { stage: string; reason: string } | null {
  if (status !== 503) {
    return null;
  }
  const body = parsed as { error?: { type?: unknown }; stage?: unknown; reason?: unknown } | null;
  if (body?.error?.type !== 'gatekeeper_error') {
    return null;
  }
  return {
    stage: typeof body.stage === 'string' && body.stage ? body.stage : 'policy',
    reason: typeof body.reason === 'string' && body.reason ? body.reason : 'no valid verdict',
  };
}

/**
 * A transport failure after the headers were out, with the upstream's own wording
 * kept out of it: the stream broke, and why it broke at the socket level is
 * operator detail.
 */
function asUpstreamFailure(failure: unknown): OpenAiApiError {
  return failure instanceof OpenAiApiError
    ? failure
    : openAiErrors.backendUnavailable('The external model endpoint stopped sending data.');
}

async function readBody(upstream: Response): Promise<{ text: string; parsed: unknown }> {
  let text = '';
  try {
    text = (await upstream.text()).slice(0, 1000);
  } catch {
    return { text: '', parsed: null };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const message = (parsed as { error?: { message?: unknown } } | null)?.error?.message;
    return { text: typeof message === 'string' ? message : text, parsed };
  } catch {
    return { text, parsed: null };
  }
}
