import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedApiKey } from '../../api-keys/index.js';
import { type CatalogModel, CatalogService } from '../../catalog/catalog.service.js';
import type { ApiKey } from '../../db/entities/api-key.entity.js';
import type { ModelCapability } from '../../db/entities/model.entity.js';
import { CREDITS_GATEWAY, type CreditsGateway } from '../../metering/credits.gateway.js';
import type { RouteKind } from './gateway.types.js';
import { openAiErrors } from './openai-error.js';
import { RateLimitService } from './rate-limit.service.js';

/** Which capability each route needs the model to declare. */
const REQUIRED_CAPABILITY: Record<RouteKind, ModelCapability> = {
  chat: 'chat',
  completions: 'completions',
  embeddings: 'embeddings',
};

/**
 * Everything that decides whether a request is served, before a byte goes
 * upstream: does the model exist, may this key call it, is there credit, is the
 * caller within its budget.
 *
 * Kept apart from the forwarding path so the order of those checks — and the
 * exact status code each produces — is readable in one place and testable
 * without an upstream.
 */
@Injectable()
export class GatewayPolicyService {
  constructor(
    private readonly catalog: CatalogService,
    @Inject(CREDITS_GATEWAY) private readonly credits: CreditsGateway,
    private readonly rateLimits: RateLimitService,
  ) {}

  /** Resolves `body.model` to a routable model, or throws the contract's error. */
  resolve(kind: RouteKind, body: Record<string, unknown>, key: ApiKey): CatalogModel {
    const requested = body.model;
    if (typeof requested !== 'string' || requested.length === 0) {
      throw openAiErrors.missingField('model');
    }
    const model = this.catalog.find(requested);
    if (!model) {
      throw openAiErrors.modelNotFound(requested);
    }
    // Scope before capability: a key that may not see the model should not
    // learn what the model can do.
    if (key.modelScope && !key.modelScope.includes(model.id)) {
      throw openAiErrors.modelNotInKeyScope(requested);
    }
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

  listModels(key: ApiKey): CatalogModel[] {
    return this.catalog.list(key.modelScope);
  }
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
