import { beforeEach, describe, expect, it } from 'vitest';
import type { CatalogModel, CatalogService } from '../../catalog/catalog.service.js';
import type { ApiKey } from '../../db/entities/api-key.entity.js';
import type {
  ExternalCatalogModel,
  ExternalCatalogService,
  UnadmittedExternalModel,
} from '../../external-endpoints/index.js';
import type { CreditsGateway } from '../../metering/credits.gateway.js';
import { GatewayPolicyService } from './gateway-policy.service.js';
import { OpenAiApiError } from './openai-error.js';
import type { RateLimitService } from './rate-limit.service.js';

/**
 * Admission across two catalogues (ADR-008 §4), which is the whole of what this
 * spec is about: the forwarding path never asks where a model came from, so
 * everything that distinguishes the two origins has to be decided — and refused —
 * here.
 */

const CONFIG_MODEL: CatalogModel = {
  id: 'mock/chat:tdx',
  name: 'Mock chat',
  litellmModel: 'mock/chat',
  contextLength: 4096,
  capabilities: ['chat'],
  promptPer1mMicros: 1,
  completionPer1mMicros: 1,
  endpoint: { id: 'ep-1', name: 'mock-primary', hostname: 'primary.example', tee: 'Intel TDX', declaredImages: null },
  updatedAt: new Date('2026-10-06T00:00:00Z'),
};

const EXTERNAL_MODEL: ExternalCatalogModel = {
  id: 'partner/chat:snp',
  name: 'Partner chat',
  upstreamModel: 'partner-chat',
  contextLength: 8192,
  capabilities: ['chat'],
  promptPer1mMicros: 2,
  completionPer1mMicros: 2,
  tee: 'AMD SEV-SNP',
  endpoint: {
    id: 'xep-1',
    name: 'partner-cloud',
    hostname: 'api.partner.example',
    baseUrl: 'https://api.partner.example',
    listenPort: 19_001,
    apiKeyCiphertext: 'v1.sealed',
    measurementSeen: null,
    evidenceDigestSeen: 'sha256/upstream',
  },
  updatedAt: new Date('2026-10-06T00:00:00Z'),
};

interface Catalogues {
  config?: CatalogModel[];
  external?: ExternalCatalogModel[];
  unadmitted?: UnadmittedExternalModel[];
}

function policyOver(catalogues: Catalogues): GatewayPolicyService {
  const config = catalogues.config ?? [];
  const external = catalogues.external ?? [];
  const unadmitted = catalogues.unadmitted ?? [];

  const catalog = {
    list: (scope: readonly string[] | null = null) =>
      scope ? config.filter((model) => scope.includes(model.id)) : config,
    find: (id: string) => config.find((model) => model.id === id),
  } as unknown as CatalogService;

  const externalCatalog = {
    list: (scope: readonly string[] | null = null) =>
      scope ? external.filter((model) => scope.includes(model.id)) : external,
    find: (id: string) => external.find((model) => model.id === id),
    findUnadmitted: (id: string) => unadmitted.find((model) => model.id === id),
  } as unknown as ExternalCatalogService;

  const credits = { balanceOf: async () => ({ spendable: true }) } as unknown as CreditsGateway;
  const rateLimits = { admit: async () => ({ headers: {} }) } as unknown as RateLimitService;

  return new GatewayPolicyService(catalog, externalCatalog, credits, rateLimits);
}

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return { id: 'key-1', workspaceId: 'ws-1', modelScope: null, ...overrides } as ApiKey;
}

function refusal(call: () => unknown): OpenAiApiError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(OpenAiApiError);
    return error as OpenAiApiError;
  }
  throw new Error('Expected admission to refuse the request.');
}

let unadmittedPending: UnadmittedExternalModel;

beforeEach(() => {
  unadmittedPending = {
    id: EXTERNAL_MODEL.id,
    endpointName: 'partner-cloud',
    status: 'pending',
    stage: null,
    reason: null,
  };
});

describe('resolve', () => {
  it('resolves a config model to the LiteLLM leg', () => {
    const policy = policyOver({ config: [CONFIG_MODEL] });

    const resolved = policy.resolve('chat', { model: CONFIG_MODEL.id }, apiKey());

    expect(resolved).toMatchObject({ origin: 'config', upstreamModel: 'mock/chat', external: null });
  });

  it('resolves an admitted external model to the egress leg', () => {
    const policy = policyOver({ external: [EXTERNAL_MODEL] });

    const resolved = policy.resolve('chat', { model: EXTERNAL_MODEL.id }, apiKey());

    expect(resolved).toMatchObject({ origin: 'external', upstreamModel: 'partner-chat' });
    expect(resolved.external?.baseUrl).toBe('http://127.0.0.1:19001');
  });

  it('refuses a registered external model whose endpoint has no verdict, with 503 attestation_failed', () => {
    // Decision 5's fail-closed drop, enforced at admission as well as at the
    // egress: the request never reaches the sidecar.
    const policy = policyOver({ unadmitted: [unadmittedPending] });

    const error = refusal(() => policy.resolve('chat', { model: EXTERNAL_MODEL.id }, apiKey()));

    expect(error.status).toBe(503);
    expect(error.type).toBe('gatekeeper_error');
    expect(error.code).toBe('attestation_failed');
    expect(error.message).toContain('partner-cloud');
    expect(error.message).toContain('has not yet verified it');
    expect(error.message).toContain('Nothing was sent to it.');
  });

  it('names the stage and reason a denial came from', () => {
    const policy = policyOver({
      unadmitted: [
        { ...unadmittedPending, status: 'denied', stage: 'policy', reason: 'measurement is not on the trust list' },
      ],
    });

    const error = refusal(() => policy.resolve('chat', { model: EXTERNAL_MODEL.id }, apiKey()));

    expect(error.code).toBe('attestation_failed');
    expect(error.message).toContain('at stage policy');
    expect(error.message).toContain('measurement is not on the trust list');
  });

  it('refuses a cacheable copy of the refusal', () => {
    // A cached 503 would outlive the verdict that produced it, which is the one
    // thing a fail-closed refusal must not do.
    const policy = policyOver({ unadmitted: [unadmittedPending] });

    const error = refusal(() => policy.resolve('chat', { model: EXTERNAL_MODEL.id }, apiKey()));

    expect(error.headers['Cache-Control']).toBe('no-store');
  });

  it('answers 404 for a model nobody registered, external or otherwise', () => {
    const policy = policyOver({ config: [CONFIG_MODEL] });

    const error = refusal(() => policy.resolve('chat', { model: 'nobody/else:snp' }, apiKey()));

    expect(error.status).toBe(404);
    expect(error.code).toBe('model_not_found');
  });

  it('checks the key’s scope before it reveals an endpoint’s verdict', () => {
    // Scope comes first for the same reason it comes before the capability check:
    // a key that may not see the model should not learn anything about it — and
    // "its upstream failed attestation" is something about it.
    const policy = policyOver({ unadmitted: [unadmittedPending] });

    const error = refusal(() =>
      policy.resolve('chat', { model: EXTERNAL_MODEL.id }, apiKey({ modelScope: ['something/else:tdx'] })),
    );

    expect(error.status).toBe(403);
    expect(error.code).toBe('model_not_in_key_scope');
  });

  it('applies the capability check to an external model like any other', () => {
    const policy = policyOver({ external: [EXTERNAL_MODEL] });

    const error = refusal(() => policy.resolve('embeddings', { model: EXTERNAL_MODEL.id }, apiKey()));

    expect(error.code).toBe('unsupported_parameter');
  });

  it('applies the unsupported-parameter check to an external model like any other', () => {
    const policy = policyOver({ external: [EXTERNAL_MODEL] });

    const error = refusal(() => policy.resolve('chat', { model: EXTERNAL_MODEL.id, n: 2 }, apiKey()));

    expect(error.code).toBe('unsupported_parameter');
    expect(error.param).toBe('n');
  });
});

describe('listModels', () => {
  it('lists config models first, then the external ones a verdict admits', () => {
    const policy = policyOver({ config: [CONFIG_MODEL], external: [EXTERNAL_MODEL] });

    expect(policy.listModels(apiKey()).map((model) => model.id)).toEqual([CONFIG_MODEL.id, EXTERNAL_MODEL.id]);
  });

  it('omits an external model whose endpoint holds no verdict', () => {
    const policy = policyOver({ config: [CONFIG_MODEL], unadmitted: [unadmittedPending] });

    expect(policy.listModels(apiKey()).map((model) => model.id)).toEqual([CONFIG_MODEL.id]);
  });

  it('honours the key’s scope across both catalogues', () => {
    const policy = policyOver({ config: [CONFIG_MODEL], external: [EXTERNAL_MODEL] });

    expect(policy.listModels(apiKey({ modelScope: [EXTERNAL_MODEL.id] })).map((model) => model.id)).toEqual([
      EXTERNAL_MODEL.id,
    ]);
  });
});
