import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedApiKey } from '../../api-keys/index.js';
import { CatalogService } from '../../catalog/catalog.service.js';
import type { ApiKey } from '../../db/entities/api-key.entity.js';
import type { ModelCapability } from '../../db/entities/model.entity.js';
import { ExternalCatalogService, type UnadmittedExternalModel } from '../../external-endpoints/index.js';
import { CREDITS_GATEWAY, type CreditsGateway } from '../../metering/credits.gateway.js';
import type { RoutedModel, RouteKind } from './gateway.types.js';
import { type OpenAiApiError, openAiErrors } from './openai-error.js';
import { RateLimitService } from './rate-limit.service.js';
import { routedConfigModel, routedExternalModel } from './routed-model.js';

/** Which capability each route needs the model to declare. */
const REQUIRED_CAPABILITY: Record<RouteKind, ModelCapability> = {
  chat: 'chat',
  completions: 'completions',
  embeddings: 'embeddings',
};

/**
 * Everything that decides whether a request is served, before a byte goes
 * upstream: does the model exist, may this key call it, is its endpoint attested,
 * is there credit, is the caller within its budget.
 *
 * Kept apart from the forwarding path so the order of those checks — and the
 * exact status code each produces — is readable in one place and testable
 * without an upstream.
 */
@Injectable()
export class GatewayPolicyService {
  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    private readonly catalog: CatalogService,
    private readonly externalCatalog: ExternalCatalogService,
    @Inject(CREDITS_GATEWAY) private readonly credits: CreditsGateway,
    private readonly rateLimits: RateLimitService,
  ) {}

  /** Resolves `body.model` to a routable model, or throws the contract's error. */
  resolve(kind: RouteKind, body: Record<string, unknown>, key: ApiKey): RoutedModel {
    const requested = body.model;
    if (typeof requested !== 'string' || requested.length === 0) {
      throw openAiErrors.missingField('model');
    }

    const found = this.lookUp(requested);
    if (!found) {
      throw openAiErrors.modelNotFound(requested);
    }
    // Scope before everything else: a key that may not see the model should not
    // learn what the model can do — nor, now, what its endpoint's verdict is.
    if (key.modelScope && !key.modelScope.includes(found.id)) {
      throw openAiErrors.modelNotInKeyScope(requested);
    }
    if (found.kind === 'unadmitted') {
      throw refusalFor(found.unadmitted);
    }

    const model = found.model;
    if (!model.capabilities.includes(REQUIRED_CAPABILITY[kind])) {
      throw openAiErrors.unsupportedParameter('model', `Model "${model.id}" does not support ${kind} requests.`);
    }
    assertSupportedParameters(body);
    return model;
  }

  /**
   * Credit and budget checks, in the order the client can act on: no credit is
   * a billing problem, a spend limit is a key setting, a rate limit resolves by
   * waiting.
   */
  async admit(auth: AuthenticatedApiKey): Promise<Record<string, string>> {
    const balance = await this.credits.balanceOf(auth.workspace.id);
    if (!balance.spendable) {
      throw openAiErrors.insufficientCredits();
    }
    if (auth.key.spendLimitMicros !== null && auth.key.spentTotalMicros >= auth.key.spendLimitMicros) {
      throw openAiErrors.keySpendLimitReached();
    }
    const grant = await this.rateLimits.admit(auth.key);
    return grant.headers;
  }

  /** Charges the token budget once the real usage is known. */
  async settle(key: ApiKey, totalTokens: number): Promise<void> {
    await this.rateLimits.settle(key, totalTokens);
  }

  /**
   * What `GET /v1/models` lists: config models in config order, then the external
   * models a live verdict currently admits.
   *
   * An external model whose endpoint is not `verified` is absent — decision 5's
   * fail-closed drop, and the reason this method and {@link resolve} read the same
   * map rather than each applying the rule themselves.
   */
  listModels(key: ApiKey): RoutedModel[] {
    return [
      ...this.catalog.list(key.modelScope).map(routedConfigModel),
      ...this.externalCatalog.list(key.modelScope).map(routedExternalModel),
    ];
  }

  /**
   * One model id against both catalogues, plus the third answer the external one
   * makes possible: registered, but not admitted.
   */
  private lookUp(id: string): Resolution | null {
    const config = this.catalog.find(id);
    if (config) {
      return { kind: 'routable', id, model: routedConfigModel(config) };
    }
    const external = this.externalCatalog.find(id);
    if (external) {
      return { kind: 'routable', id, model: routedExternalModel(external) };
    }
    const unadmitted = this.externalCatalog.findUnadmitted(id);
    return unadmitted ? { kind: 'unadmitted', id, unadmitted } : null;
  }
}

/** What a model id resolves to: something routable, or something refused on purpose. */
type Resolution =
  | { kind: 'routable'; id: string; model: RoutedModel }
  | { kind: 'unadmitted'; id: string; unadmitted: UnadmittedExternalModel };

/**
 * The router's own half of fail-closed: a model whose endpoint holds no verdict is
 * refused here, before a connection is opened, with the same 503 the sidecar would
 * answer one hop later (ADR-008 §4).
 *
 * Both refusals exist on purpose. This one keeps the request off the wire and
 * names the stage that denied; the sidecar's covers the window between a verdict
 * flip and the status poll that projects it.
 */
function refusalFor(unadmitted: UnadmittedExternalModel): OpenAiApiError {
  const because =
    unadmitted.status === 'pending'
      ? 'the router has not yet verified it'
      : `the router denied it${unadmitted.stage ? ` at stage ${unadmitted.stage}` : ''}${
          unadmitted.reason ? `: ${unadmitted.reason}` : ''
        }`;
  return openAiErrors.attestationFailed(
    `Model "${unadmitted.id}" is served by external endpoint "${unadmitted.endpointName}", and ${because}. ` +
      'Nothing was sent to it.',
  );
}

/**
 * The handful of OpenAI parameters the router cannot honour. Everything else —
 * including fields this router has never heard of — is forwarded unchanged.
 */
function assertSupportedParameters(body: Record<string, unknown>): void {
  const n = body.n;
  if (n !== undefined && n !== null && n !== 1) {
    throw openAiErrors.unsupportedParameter(
      'n',
      'Only n = 1 is supported; the router meters one completion per request.',
    );
  }
}
