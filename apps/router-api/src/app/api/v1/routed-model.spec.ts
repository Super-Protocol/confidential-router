import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '../../catalog/catalog.service.js';
import type { ExternalCatalogModel } from '../../external-endpoints/index.js';
import { routedConfigModel, routedExternalModel } from './routed-model.js';

const UPDATED_AT = new Date('2026-10-06T12:00:00Z');

const CONFIG: CatalogModel = {
  id: 'meta/llama-3.3-70b-instruct:tdx',
  name: 'Llama 3.3 70B',
  litellmModel: 'llama-3.3-70b',
  contextLength: 131_072,
  capabilities: ['chat'],
  promptPer1mMicros: 280_000,
  completionPer1mMicros: 420_000,
  endpoint: {
    id: 'ep-1',
    name: 'llama-33-70b',
    hostname: 'llama.tee.example',
    tee: 'Intel TDX + H100 CC',
    declaredImages: null,
  },
  updatedAt: UPDATED_AT,
};

const EXTERNAL: ExternalCatalogModel = {
  id: 'partner/llama-3.3-70b:snp',
  name: 'Partner Llama',
  upstreamModel: 'llama-3.3-70b-instruct',
  contextLength: 131_072,
  capabilities: ['chat', 'completions'],
  promptPer1mMicros: 400_000,
  completionPer1mMicros: 800_000,
  tee: 'AMD SEV-SNP',
  endpoint: {
    id: 'xep-1',
    name: 'partner-cloud',
    hostname: 'api.partner.example',
    baseUrl: 'https://api.partner.example',
    listenPort: 19_001,
    apiKeyCiphertext: 'v1.sealed',
    measurementSeen: 'a'.repeat(64),
    evidenceDigestSeen: 'sha256/upstream',
  },
  updatedAt: UPDATED_AT,
};

describe('routedConfigModel', () => {
  it('routes to LiteLLM, under the name LiteLLM knows', () => {
    expect(routedConfigModel(CONFIG)).toEqual({
      id: CONFIG.id,
      name: CONFIG.name,
      upstreamModel: 'llama-3.3-70b',
      contextLength: 131_072,
      capabilities: ['chat'],
      promptPer1mMicros: 280_000,
      completionPer1mMicros: 420_000,
      origin: 'config',
      endpoint: { id: 'ep-1', name: 'llama-33-70b', hostname: 'llama.tee.example', tee: 'Intel TDX + H100 CC' },
      external: null,
      updatedAt: UPDATED_AT,
    });
  });
});

describe('routedExternalModel', () => {
  it('routes to the sidecar’s loopback listener, under the name the upstream knows', () => {
    const routed = routedExternalModel(EXTERNAL);

    expect(routed.upstreamModel).toBe('llama-3.3-70b-instruct');
    // Loopback, and only loopback: router-api never dials the upstream itself,
    // because the pinned-certificate handshake is the sidecar's (ADR-008 §4).
    expect(routed.external?.baseUrl).toBe('http://127.0.0.1:19001');
    expect(routed.origin).toBe('external');
  });

  it('names the upstream’s hostname, not the loopback address the request went to', () => {
    // This is what `usage.endpoint`, `X-Confidential-Router-Endpoint` and
    // `/v1/models` report. A client comparing it against the evidence it inspected
    // has to see the host that evidence is about.
    expect(routedExternalModel(EXTERNAL).endpoint).toEqual({
      id: 'xep-1',
      name: 'partner-cloud',
      hostname: 'api.partner.example',
      tee: 'AMD SEV-SNP',
    });
  });

  it('carries the sealed key and the digest the admitting verdict observed', () => {
    expect(routedExternalModel(EXTERNAL).external).toEqual({
      baseUrl: 'http://127.0.0.1:19001',
      apiKeyCiphertext: 'v1.sealed',
      evidenceDigestSeen: 'sha256/upstream',
      measurementSeen: 'a'.repeat(64),
    });
  });

  it('is priced from the row, so the ledger sees admin-set prices like any other', () => {
    expect(routedExternalModel(EXTERNAL)).toMatchObject({
      promptPer1mMicros: 400_000,
      completionPer1mMicros: 800_000,
    });
  });
});
