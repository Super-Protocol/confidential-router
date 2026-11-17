import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig } from '../config.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { SecretEnvelopeService } from '../secrets/index.js';

/** Most models one discovery reports — a bound on a stranger's answer; registration caps at 50 of them. */
export const MAX_DISCOVERED_MODELS = 100;

/** One model the upstream's own `/v1/models` lists, with whatever it says about itself. */
export interface DiscoveredModel {
  /** The upstream's id for it — what `ExternalModelInput.upstreamModel` takes. */
  upstreamModel: string;
  /** A display name, when the upstream published one. */
  name: string | null;
  contextLength: number | null;
  /** Price hints, when the upstream is itself a router that publishes them (`models.controller.ts`). */
  promptPer1mMicros: number | null;
  completionPer1mMicros: number | null;
  /** The public id this endpoint already publishes it under, if it is registered. */
  registeredAs: string | null;
}

/**
 * Asks an attested upstream which models it serves (SUP-249).
 *
 * The point of the order: discovery is *after* attestation, never instead of it.
 * The admin pastes a URL and a key, the endpoint is registered with no models,
 * the sidecar attests it like any other — and only when that verdict is
 * `verified` does this service send the first request, through the same loopback
 * listener the egress leg uses. So even the listing call only ever reaches an
 * upstream whose evidence verified, whose measurement is on the trust list and
 * whose TLS leaf is pinned; the sidecar refuses it fail-closed otherwise, and
 * this service refuses before asking.
 *
 * Read-only: nothing here writes a row. The admin picks from the answer and
 * registers the models through the ordinary `updateExternalEndpoint`.
 */
@Injectable()
export class ExternalModelDiscoveryService {
  private readonly logger = new Logger(ExternalModelDiscoveryService.name);

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly secrets: SecretEnvelopeService,
  ) {}

  async discover(externalEndpointId: string): Promise<DiscoveredModel[]> {
    const endpoint = await this.dataSource
      .getRepository(ExternalEndpoint)
      .findOne({ where: { id: externalEndpointId } });
    if (!endpoint) {
      throw new NotFoundException('External endpoint not found.');
    }
    if (!endpoint.enabled || endpoint.status !== 'verified') {
      // 409, quotable: the console shows it beside the status chips, and the
      // admin's next step is to wait for the verdict or fix the trust list.
      throw new ConflictException(
        `"${endpoint.name}" is not verified by this router yet (status ${endpoint.status.toUpperCase()}), ` +
          'so it has not been asked for its models: discovery only talks to an attested upstream.',
      );
    }

    const listed = await this.fetchModels(endpoint);
    const registered = await this.dataSource.getRepository(Model).find({
      where: { externalEndpointId: endpoint.id, enabled: true },
      select: { id: true, litellmModel: true },
    });
    const publicIdOf = new Map(registered.map((model) => [model.litellmModel, model.id]));
    return listed.map((model) => ({ ...model, registeredAs: publicIdOf.get(model.upstreamModel) ?? null }));
  }

  private async fetchModels(endpoint: ExternalEndpoint): Promise<Omit<DiscoveredModel, 'registeredAs'>[]> {
    const apiKey = this.openKey(endpoint);
    const url = `http://127.0.0.1:${endpoint.listenPort}/v1/models`;
    const signal = AbortSignal.timeout(this.config.externalEndpoints.connectTimeout * 2);
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        signal,
      });
      text = await readCapped(response, MAX_LIST_BYTES);
    } catch (error) {
      // The address, never the key — and the cause stays in the log.
      this.logger.warn(`Model discovery for "${endpoint.name}" (${url}) failed: ${messageOf(error)}`);
      throw new ConflictException(
        error instanceof ListTooLargeError
          ? `"${endpoint.name}" answered GET /v1/models with more than ${MAX_LIST_BYTES / 1_000_000} MB; enter its models by hand.`
          : `"${endpoint.name}" did not answer GET /v1/models in time through the egress; try again.`,
      );
    }

    const body = parseJson(text);
    if (!response.ok) {
      throw new ConflictException(refusalOf(endpoint.name, response.status, body));
    }
    const models = parseModelList(body);
    if (models === null) {
      throw new ConflictException(`"${endpoint.name}" did not answer GET /v1/models with an OpenAI model list.`);
    }
    return models;
  }

  /**
   * The stored key, or the operator's problem said as one. A data key that is
   * unset or was rotated since the row was sealed is not something retrying
   * discovery can fix, so it is not reported as if it were the network.
   */
  private openKey(endpoint: ExternalEndpoint): string {
    try {
      return this.secrets.open(endpoint.apiKeyCiphertext, endpoint.id);
    } catch (error) {
      this.logger.error(`Cannot open the stored upstream API key for "${endpoint.name}": ${messageOf(error)}`);
      throw new ServiceUnavailableException(
        `The stored API key for "${endpoint.name}" cannot be opened with this deployment's data key ` +
          '(CR_API_SECRETS_KEY unset or changed since it was stored). Rotate the key to store it again.',
      );
    }
  }
}

/** Most of a model list one discovery reads before giving up on it. */
export const MAX_LIST_BYTES = 2_000_000;

class ListTooLargeError extends Error {}

/** The body, read up to `limit` bytes — a stranger's answer does not get to size this process's memory. */
async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ListTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** What to tell the admin about a non-2xx, by who said no. */
function refusalOf(name: string, status: number, body: unknown): string {
  const denial = gatekeeperDenialOf(body);
  if (denial) {
    return `The router's egress refused "${name}" (${denial}); nothing was sent upstream.`;
  }
  if (status === 401 || status === 403) {
    return `"${name}" refused the stored API key (${status}). Rotate it and ask again.`;
  }
  if (status === 404 || status === 405) {
    return `"${name}" does not serve GET /v1/models (${status}). Enter its models by hand instead.`;
  }
  return `"${name}" answered ${status} to GET /v1/models. Try again later.`;
}

/**
 * An OpenAI `{ object: "list", data: [...] }`, read leniently: only `id` is
 * required, and the hints are taken from the fields the upstreams we know of
 * publish — `context_length` and `pricing.*_per_1m_micros` (a Confidential
 * Router), `max_model_len` (vLLM). Duplicates and blanks are dropped.
 */
export function parseModelList(body: unknown): Omit<DiscoveredModel, 'registeredAs'>[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return null;
  }
  const seen = new Set<string>();
  const models: Omit<DiscoveredModel, 'registeredAs'>[] = [];
  for (const entry of data) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || id.length > 255 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const pricing = (row.pricing ?? {}) as Record<string, unknown>;
    models.push({
      upstreamModel: id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 255) : null,
      contextLength: positiveInt(row.context_length) ?? positiveInt(row.max_model_len),
      promptPer1mMicros: nonNegativeInt(pricing.prompt_per_1m_micros),
      completionPer1mMicros: nonNegativeInt(pricing.completion_per_1m_micros),
    });
    if (models.length === MAX_DISCOVERED_MODELS) {
      break;
    }
  }
  return models;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInt(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** `stage: reason` from the sidecar's fail-closed body, or null. */
function gatekeeperDenialOf(body: unknown): string | null {
  const parsed = body as { error?: { type?: unknown }; stage?: unknown; reason?: unknown } | null;
  if (parsed?.error?.type !== 'gatekeeper_error') {
    return null;
  }
  const stage = typeof parsed.stage === 'string' && parsed.stage ? parsed.stage : 'policy';
  const reason = typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : 'no valid verdict';
  return `${stage}: ${reason}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
