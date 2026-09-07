import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { loadCaseBody, loadConformanceManifest } from '@confidential-router/attestation-fixtures';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidencePollerService } from '../src/app/evidence/index.js';
import { createHarness, type Harness, pathOf } from './app-harness.js';

/**
 * The whole evidence path against the real application: a mock publisher serves
 * a conformance fixture, the poller files it, the console reads it back and the
 * REST passthrough hands it to tooling.
 *
 * The publisher serves one endpoint's bundle and refuses the other's, because
 * "this endpoint publishes nothing" is a state the console has to render rather
 * than an error the router propagates.
 */

const PUBLISHING = 'router.example.test';
const SILENT = 'silent.example.test';
const DIGEST = 'sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs';

const manifest = loadConformanceManifest();
const bundle = loadCaseBody(
  manifest.cases.find((testCase) => testCase.id === 'valid-rsa-deployment') as never,
) as Record<string, unknown>;

let harness: Harness;
let publisher: Server;
let publisherRequests = 0;

function server() {
  return harness.app.getHttpServer();
}

/** Serves the fixture for one host and 503s for the other. */
async function startPublisher(): Promise<number> {
  publisher = createServer((req, res) => {
    publisherRequests += 1;
    if (req.url === '/published/.well-known/swarm-evidence') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(bundle));
      return;
    }
    res.writeHead(503).end('unavailable');
  });
  await new Promise<void>((resolve) => publisher.listen(0, '127.0.0.1', resolve));
  return (publisher.address() as AddressInfo).port;
}

/** Full magic-link sign-in; returns the cookies a browser would keep. */
async function signIn(email: string): Promise<string[]> {
  await request(server()).post('/auth/sign-in/magic-link').send({ email, callbackURL: '/' });
  const verify = await request(server()).get(pathOf(harness.mailer.last.url));
  const cookies = verify.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies : [cookies].filter(Boolean);
}

async function graphql(query: string, cookies: string[], variables: Record<string, unknown> = {}) {
  const response = await request(server()).post('/graphql').set('Cookie', cookies).send({ query, variables });
  expect(response.body.errors, JSON.stringify(response.body.errors)).toBeUndefined();
  return response.body.data;
}

let cookies: string[];
let workspaceId: string;

beforeAll(async () => {
  const port = await startPublisher();

  harness = await createHarness({
    config: {
      version: 1,
      endpoints: [
        {
          name: 'published',
          hostname: PUBLISHING,
          tee: 'Intel TDX + H100 CC',
          evidenceUrl: `http://127.0.0.1:${port}/published/.well-known/swarm-evidence`,
        },
        {
          name: 'silent',
          hostname: SILENT,
          tee: 'AMD SEV-SNP',
          evidenceUrl: `http://127.0.0.1:${port}/silent/.well-known/swarm-evidence`,
        },
      ],
      models: [
        {
          id: 'meta/llama-3.3-70b-instruct:tdx',
          name: 'Llama 3.3 70B Instruct',
          litellmModel: 'vllm/llama-3.3-70b-instruct',
          endpoint: 'published',
          contextLength: 131072,
          pricing: { promptPer1mMicros: 280000, completionPer1mMicros: 420000 },
        },
        {
          id: 'alibaba/qwen2.5-72b-instruct:snp',
          name: 'Qwen2.5 72B Instruct',
          litellmModel: 'vllm/qwen2.5-72b-instruct',
          endpoint: 'silent',
          contextLength: 131072,
          pricing: { promptPer1mMicros: 240000, completionPer1mMicros: 360000 },
        },
      ],
      evidence: {
        // The suite drives the poller itself; a background timer would race it.
        pollInterval: '0s',
        // The fixtures are dated January 2026, so give the window enough room
        // for them to still count as fresh whenever this suite runs.
        freshnessWindow: '87600h',
      },
    },
  });

  cookies = await signIn('evidence@example.com');
  const me = await graphql('{ me { workspaces { id } } }', cookies);
  workspaceId = me.me.workspaces[0].id;
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await new Promise<void>((resolve) => publisher?.close(() => resolve()));
});

describe('the evidence poller', () => {
  it('files what the publisher serves and lets the silent endpoint be silent', async () => {
    const report = await harness.app.get(EvidencePollerService).pollAll();

    expect(report).toEqual({ polled: 2, stored: 1, failed: 1 });
  });

  it('files a second pass without duplicating the publication', async () => {
    await harness.app.get(EvidencePollerService).pollAll();

    const data = await graphql(
      `query ($id: ID!) { endpoints(workspaceId: $id) { name latestEvidence { id } } }`,
      cookies,
      { id: workspaceId },
    );
    const published = data.endpoints.find((endpoint: { name: string }) => endpoint.name === 'published');
    const snapshots = await graphql(
      `query ($id: ID!) { evidenceSnapshots(endpointId: $id) { edges { node { id } } } }`,
      cookies,
      { id: (await endpointIds()).published },
    );

    expect(published.latestEvidence).not.toBeNull();
    expect(snapshots.evidenceSnapshots.edges).toHaveLength(1);
  });
});

async function endpointIds(): Promise<Record<string, string>> {
  const data = await graphql(`query ($id: ID!) { endpoints(workspaceId: $id) { id name } }`, cookies, {
    id: workspaceId,
  });
  return Object.fromEntries(
    data.endpoints.map((endpoint: { id: string; name: string }) => [endpoint.name, endpoint.id]),
  );
}

describe('the console view', () => {
  it('shows each endpoint with what it publishes, and nothing else', async () => {
    const data = await graphql(
      `query ($id: ID!) {
        endpoints(workspaceId: $id) {
          name
          hostname
          tee
          evidenceState
          tokensRouted30d
          latestEvidence {
            evidenceDigest
            evidenceDigestHex
            certFingerprint
            certFingerprintHex
            quoteFormat
            quoteAgeSeconds
            containerImages
            jws
            chain { subject issuer fingerprint fingerprintHex isRoot }
            measurements { name value }
          }
        }
      }`,
      cookies,
      { id: workspaceId },
    );

    const published = data.endpoints.find((endpoint: { name: string }) => endpoint.name === 'published');
    const silent = data.endpoints.find((endpoint: { name: string }) => endpoint.name === 'silent');

    expect(published).toMatchObject({ hostname: PUBLISHING, evidenceState: 'PUBLISHED', tokensRouted30d: 0 });
    expect(published.latestEvidence).toMatchObject({ evidenceDigest: DIGEST, quoteFormat: 'intel-tdx-quote-v5' });
    // Every fingerprint is served in both spellings: the canonical one the
    // bundle carries, and the hex one the console renders and copies so that a
    // digest reads the same here and in the gatekeeper (SUP-115).
    expect(published.latestEvidence.evidenceDigestHex).toHaveLength(64);
    expect(published.latestEvidence.certFingerprintHex).toMatch(/^[0-9a-f]{64}$/);
    for (const cert of published.latestEvidence.chain) {
      expect(cert.fingerprintHex).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(published.latestEvidence.quoteAgeSeconds).toBeGreaterThan(0);
    expect(published.latestEvidence.containerImages.length).toBeGreaterThan(0);
    expect(published.latestEvidence.jws.split('.')).toHaveLength(3);
    expect(published.latestEvidence.chain.at(-1).isRoot).toBe(true);
    expect(published.latestEvidence.chain[0].isRoot).toBe(false);

    expect(silent).toMatchObject({ hostname: SILENT, evidenceState: 'NOT_PUBLISHED', latestEvidence: null });
  });

  it('hands the raw bundle to an exporter', async () => {
    const data = await graphql(
      `query ($id: ID!) { endpoints(workspaceId: $id) { name latestEvidence { bundle } } }`,
      cookies,
      { id: workspaceId },
    );

    const published = data.endpoints.find((endpoint: { name: string }) => endpoint.name === 'published');
    expect(published.latestEvidence.bundle).toMatchObject({ version: '1', kind: 'DeploymentEvidence' });
  });

  it('lists the models of the config with their prices and endpoints', async () => {
    const data = await graphql(
      `{ models { id slug name contextLength capabilities tee pricing { promptPer1m completionPer1m } endpoint { name hostname } } }`,
      cookies,
    );

    expect(data.models).toHaveLength(2);
    expect(data.models[0]).toMatchObject({
      id: 'meta/llama-3.3-70b-instruct:tdx',
      slug: 'meta/llama-3.3-70b-instruct:tdx',
      contextLength: 131072,
      capabilities: ['CHAT', 'COMPLETIONS'],
      tee: 'Intel TDX + H100 CC',
      pricing: { promptPer1m: '280000', completionPer1m: '420000' },
      endpoint: { name: 'published', hostname: PUBLISHING },
    });
  });

  it('narrows the model list by TEE label', async () => {
    const data = await graphql(`{ models(tee: "AMD SEV-SNP") { id } }`, cookies);

    expect(data.models.map((model: { id: string }) => model.id)).toEqual(['alibaba/qwen2.5-72b-instruct:snp']);
  });

  it('reports the digest history a pinned value would have to follow', async () => {
    const ids = await endpointIds();
    const data = await graphql(
      `query ($id: ID!) { evidenceDigestHistory(endpointId: $id) { evidenceDigest snapshots } }`,
      cookies,
      { id: ids.published },
    );

    expect(data.evidenceDigestHistory).toEqual([{ evidenceDigest: DIGEST, snapshots: 1 }]);
  });

  it('reports zero coverage for a workspace that has served nothing', async () => {
    const data = await graphql(
      `query ($id: ID!, $from: DateTime!, $to: DateTime!) {
        evidenceCoverage(workspaceId: $id, from: $from, to: $to) { requests covered ratio }
      }`,
      cookies,
      { id: workspaceId, from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() },
    );

    expect(data.evidenceCoverage).toEqual({ requests: 0, covered: 0, ratio: 0 });
  });

  it('re-polls on demand for "Fetch fresh quote"', async () => {
    const ids = await endpointIds();
    const before = publisherRequests;

    const data = await graphql(`mutation ($id: ID!) { refreshEvidence(endpointId: $id) { evidenceDigest } }`, cookies, {
      id: ids.published,
    });

    expect(publisherRequests).toBeGreaterThan(before);
    expect(data.refreshEvidence.evidenceDigest).toBe(DIGEST);
  });

  it('answers "nothing published" rather than an error when a refresh fails', async () => {
    const ids = await endpointIds();

    const data = await graphql(`mutation ($id: ID!) { refreshEvidence(endpointId: $id) { evidenceDigest } }`, cookies, {
      id: ids.silent,
    });

    expect(data.refreshEvidence).toBeNull();
  });

  it('refuses an anonymous caller', async () => {
    const response = await request(server())
      .post('/graphql')
      .send({ query: `query ($id: ID!) { endpoints(workspaceId: $id) { id } }`, variables: { id: workspaceId } });

    expect(response.body.errors?.[0]?.message).toContain('Authentication is required');
  });

  it('refuses a workspace the viewer is not a member of', async () => {
    const otherCookies = await signIn('intruder@example.com');

    const response = await request(server())
      .post('/graphql')
      .set('Cookie', otherCookies)
      .send({ query: `query ($id: ID!) { endpoints(workspaceId: $id) { id } }`, variables: { id: workspaceId } });

    expect(response.body.errors?.[0]?.message).toContain('do not have access');
  });
});

describe('GET /v1/evidence/:endpoint', () => {
  it('serves the published bundle byte for byte, without a key', async () => {
    const response = await request(server()).get('/v1/evidence/published').expect(200);

    expect(response.body).toEqual(bundle);
  });

  it('accepts the hostname as well as the endpoint name', async () => {
    const response = await request(server()).get(`/v1/evidence/${PUBLISHING}`).expect(200);

    expect(response.body.certFingerprint).toBe(bundle.certFingerprint);
  });

  it('404s for an endpoint that has published nothing', async () => {
    await request(server()).get('/v1/evidence/silent').expect(404);
  });

  it('404s for an endpoint that does not exist', async () => {
    await request(server()).get('/v1/evidence/nope').expect(404);
  });
});

describe('the one architectural rule', () => {
  /**
   * ADR-002: the router publishes evidence and never reports a verdict. A field
   * called `verified`, `trusted` or `valid` appearing in this schema would be
   * the design regression the whole product is built to avoid, so the schema is
   * asserted rather than the intent documented.
   */
  it('exposes no field that could carry a verification verdict', async () => {
    const response = await request(server())
      .post('/graphql')
      .set('Cookie', cookies)
      .send({ query: '{ __schema { types { name fields { name } } } }' })
      .expect(200);

    const offenders: string[] = [];
    for (const type of response.body.data.__schema.types as { name: string; fields?: { name: string }[] }[]) {
      for (const field of type.fields ?? []) {
        if (/verif|attested|untrusted|trusted|valid/i.test(field.name)) {
          offenders.push(`${type.name}.${field.name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
