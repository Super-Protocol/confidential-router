import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { loadCaseBody, loadConformanceManifest } from '@confidential-router/attestation-fixtures';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidenceSnapshot } from '../src/app/db/entities/evidence-snapshot.entity.js';
import { ExternalEndpoint, type ExternalEndpointStatus } from '../src/app/db/entities/external-endpoint.entity.js';
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
/** A console on its own host, listed in `validClientOrigins` — the real topology. */
const CONSOLE_ORIGIN = 'https://console.example.test';
const SILENT = 'silent.example.test';
const PLATFORM = 'platform.example.test';
/** Two upstreams in other people's deployments: one admitted, one still pending. */
const UPSTREAM = 'partner.example.test';
const UPSTREAM_PENDING = 'newcomer.example.test';
const UPSTREAM_DIGEST = 'sha256/upstream-snapshot';
const DIGEST = 'sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs';
const PLATFORM_IMAGE = 'ghcr.io/super-protocol/confidential-router/router-api@sha256:21de82b6';

const manifest = loadConformanceManifest();
const bundle = loadCaseBody(
  manifest.cases.find((testCase) => testCase.id === 'valid-rsa-deployment') as never,
) as Record<string, unknown>;

/**
 * The same bundle in the shape the deployed platform actually publishes: a
 * `rootCaTeeQuote` sentinel instead of a quote it cannot produce yet, and the
 * applied Kubernetes objects instead of a pre-flattened container list.
 *
 * Both divergences are the platform's deliberate output, not corruption — the
 * first is asserted by swarm-cloud's own suite — and both used to make the
 * poller drop the bundle on the floor, which is all it took for the console to
 * report "Not published" for an endpoint a gatekeeper was admitting (SUP-157).
 */
function platformShapedBundle(): Record<string, unknown> {
  const [header, payload, signature] = (bundle.jws as string).split('.');
  const decoded = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
  const patched = {
    ...decoded,
    hostname: PLATFORM,
    evidence: {
      version: 2,
      resources: [
        { apiVersion: 'v1', kind: 'Service', metadata: { name: 'router-api' }, spec: { ports: [{ port: 80 }] } },
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'confidential-router-api' },
          spec: { template: { spec: { containers: [{ image: PLATFORM_IMAGE }] } } },
        },
      ],
    },
  };
  const encoded = Buffer.from(JSON.stringify(patched), 'utf8').toString('base64url');
  return {
    ...bundle,
    hostname: PLATFORM,
    rootCaTeeQuote: { status: 'not-implemented' },
    jws: [header, encoded, signature].join('.'),
  };
}

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
    if (req.url === '/platform/.well-known/swarm-evidence') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(platformShapedBundle()));
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
      // The deployment the CORS cases are about: the API answers on the
      // `published` endpoint's own hostname, the console lives elsewhere.
      // `validClientOrigins` is set through the environment below, which is
      // where the harness puts its own default and therefore wins over this file.
      server: { publicBaseUrl: `https://${PUBLISHING}` },
      // A public `publicBaseUrl` refuses the credit-minting manual provider
      // (SUP-167), and this suite buys nothing.
      billing: { provider: 'disabled' },
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
        {
          name: 'platform',
          hostname: PLATFORM,
          tee: 'Intel TDX + H100 CC',
          evidenceUrl: `http://127.0.0.1:${port}/platform/.well-known/swarm-evidence`,
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
    env: { CR_API_SERVER__VALID_CLIENT_ORIGINS: CONSOLE_ORIGIN },
  });

  cookies = await signIn('evidence@example.com');
  const me = await graphql('{ me { workspaces { id } } }', cookies);
  workspaceId = me.me.workspaces[0].id;
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await new Promise<void>((resolve) => publisher?.close(() => resolve()));
});

/**
 * An external upstream row, as the admin section would have registered it.
 *
 * Written directly rather than through the GraphQL mutation because this suite
 * runs no egress sidecar, so there is no verdict to be had — and the relay's
 * subject is what it does with a *stored* publication, not how one came to be
 * stored. `external-endpoints.e2e.spec.ts` owns registration;
 * `evidence.controller.spec.ts` owns the filing rule that binds a bundle to the
 * leaf a verdict pinned.
 */
async function registerUpstream(input: {
  name: string;
  hostname: string;
  status: ExternalEndpointStatus;
  evidenceDigestSeen: string | null;
}): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await harness.app
    .get(DataSource)
    .getRepository(ExternalEndpoint)
    .save({
      id,
      name: input.name,
      baseUrl: `https://${input.hostname}`,
      hostname: input.hostname,
      listenPort: 19_000 + Math.floor(Math.random() * 100),
      enabled: true,
      status: input.status,
      lastCheckedAt: input.status === 'pending' ? null : now,
      lastStage: null,
      lastReason: null,
      measurementSeen: null,
      measurementSource: null,
      evidenceDigestSeen: input.evidenceDigestSeen,
      pinnedCertFingerprint: bundle.certFingerprint as string,
      apiKeyCiphertext: 'v1.sealed',
      apiKeyPrefix: 'sk-upstr',
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

/** The upstream's publication, filed under the external endpoint and under no endpoint of ours. */
async function fileUpstreamBundle(externalEndpointId: string, evidenceDigest: string): Promise<void> {
  const now = new Date();
  await harness.app
    .get(DataSource)
    .getRepository(EvidenceSnapshot)
    .save({
      id: randomUUID(),
      // Stated, not defaulted: the XOR with `externalEndpointId` is what keeps an
      // upstream's publications out of our own endpoints' digest history.
      endpointId: null,
      externalEndpointId,
      fetchedAt: now,
      issuedAt: now,
      evidenceDigest,
      evidenceDigestHex: 'beef',
      certFingerprint: bundle.certFingerprint as string,
      quoteFormat: 'intel-tdx-quote-v5',
      containerImages: [],
      workloads: null,
      chainSummary: [],
      measurements: null,
      jws: bundle.jws as string,
      bundle,
    });
}

describe('the evidence poller', () => {
  it('files what the publisher serves and lets the silent endpoint be silent', async () => {
    const report = await harness.app.get(EvidencePollerService).pollAll();

    expect(report).toEqual({ polled: 3, stored: 2, failed: 1 });
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

    // The production shape reaches the console with the digest a user pins and
    // the image digests they compare, and says "not stated" for the quote
    // format rather than falling back to NOT_PUBLISHED (SUP-157).
    const platform = data.endpoints.find((endpoint: { name: string }) => endpoint.name === 'platform');

    expect(platform).toMatchObject({ hostname: PLATFORM, evidenceState: 'PUBLISHED' });
    expect(platform.latestEvidence).toMatchObject({ evidenceDigest: DIGEST, quoteFormat: null });
    expect(platform.latestEvidence.containerImages).toEqual([PLATFORM_IMAGE]);
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

/**
 * The passthrough — and, on every real deployment, the only copy of a published
 * bundle a browser can read (SUP-191).
 *
 * `/.well-known/swarm-evidence` is served by the platform's own gateway, below
 * this service's CORS layer, with no `Access-Control-Allow-Origin` at all; a
 * console on `console.…` therefore cannot read the evidence of an API on
 * `api.…`, and the chat's tier-1 gate has nothing to verify. These routes are
 * `/v1/*` on the API host, so `configureApp`'s `validClientOrigins` applies.
 * Nothing about authenticity rests on that: the document is a JWS over its own
 * bytes, and the browser checks the signature whichever copy it got.
 */
describe('GET /v1/evidence', () => {
  it('serves the published bundle byte for byte, without a key', async () => {
    const response = await request(server()).get('/v1/evidence/published').expect(200);

    // Hashed, not deep-compared: the acceptance check on a real deployment
    // diffs this against what the gateway serves, and a document whose members
    // this layer reordered is a different byte string with the same contents.
    expect(createHash('sha256').update(response.text, 'utf8').digest('hex')).toBe(
      createHash('sha256').update(JSON.stringify(bundle), 'utf8').digest('hex'),
    );
    expect(response.body).toEqual(bundle);
  });

  it('accepts the hostname as well as the endpoint name', async () => {
    const response = await request(server()).get(`/v1/evidence/${PUBLISHING}`).expect(200);

    expect(response.body.certFingerprint).toBe(bundle.certFingerprint);
  });

  it('answers for the deployment itself, without the caller knowing an endpoint name', async () => {
    // `server.publicBaseUrl` names the `published` endpoint's hostname, so
    // "this deployment's evidence" has exactly one answer.
    const own = await request(server()).get('/v1/evidence').expect(200);

    expect(own.body).toEqual(bundle);
  });

  it('lets a console on another origin read the body it is handed', async () => {
    for (const path of ['/v1/evidence', '/v1/evidence/published']) {
      const response = await request(server()).get(path).set('Origin', CONSOLE_ORIGIN).expect(200);

      // Without this the browser discards the response whatever it contains,
      // which is the defect: the gate could not verify and the composer stayed
      // shut on a deployment that was publishing perfectly good evidence.
      expect(response.headers['access-control-allow-origin'], path).toBe(CONSOLE_ORIGIN);
    }
  });

  it('withholds the header from an origin the deployment does not list', async () => {
    const response = await request(server())
      .get('/v1/evidence/published')
      .set('Origin', 'https://not-our-console.example')
      // Still 200: refusing CORS means omitting the header and letting the
      // browser enforce it, not answering an error to a request that may be a
      // `curl` with an Origin on it.
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('forbids any cache from holding a bundle the deployment has stopped publishing', async () => {
    for (const path of ['/v1/evidence', '/v1/evidence/published']) {
      const response = await request(server()).get(path).expect(200);

      // A bundle is re-signed every few minutes and the reader is comparing
      // freshness with a gatekeeper looking at the live host. The responses
      // carry an ETag, so without this the decision is a shared cache's
      // heuristic.
      expect(response.headers['cache-control'], path).toBe('no-store');
    }
  });

  it('says an endpoint has not been fetched yet, rather than denying it', async () => {
    const response = await request(server()).get('/v1/evidence/silent').set('Origin', CONSOLE_ORIGIN).expect(503);

    // 503 and not 404: a deployment still waiting on its first poll is a few
    // seconds of starting up, and "status 404" read on the gate's locked
    // composer as this router denying the endpoint. The reason is typed so a
    // screen branches on it instead of parsing the sentence.
    expect(response.body).toMatchObject({ reason: 'evidence_not_fetched' });
    expect(response.body.message).toContain(SILENT);
    // Never an empty 200: a caller that verifies what it is handed must not
    // have to tell a bundle from the absence of one.
    expect(response.body.version).toBeUndefined();
    // The refusal has to cross origins too, or the gate renders "status 503"
    // for a reason it was told and could not read. `enableCors` is global
    // middleware, so this holds for error responses — asserted rather than
    // assumed, because it is the half of the fix that is easy to lose.
    expect(response.headers['access-control-allow-origin']).toBe(CONSOLE_ORIGIN);
  });

  it('hands back the rootCaTeeQuote sentinel the platform published, through the database', async () => {
    // The member survives the JSON column unread and unedited, so a user
    // diffing this against what the host serves sees the same document — the
    // router neither fills the placeholder in nor drops it (SUP-157).
    const response = await request(server()).get('/v1/evidence/platform').expect(200);

    expect(response.body.rootCaTeeQuote).toEqual({ status: 'not-implemented' });
  });

  it('404s for an endpoint that does not exist, in its own error shape', async () => {
    const response = await request(server()).get('/v1/evidence/nope').expect(404);

    // `AppModule` orders `EvidenceModule` before `RestApiModule`, whose
    // `V1FallbackController` claims everything else under `/v1`. Had it not,
    // this would answer `{"error":{"code":"not_found"}}` — which the gate would
    // read as a router that has no such endpoint for every path, including the
    // ones it does have.
    // The OpenAI envelope is `{"error":{"message","type","code"}}` and carries
    // no top-level `statusCode`; Nest's own shape does.
    expect(response.body).toMatchObject({ statusCode: 404 });
    expect(response.body.message).toContain('nope');
  });
});

describe('the one architectural rule', () => {
  /**
   * The admin trust list, and nothing else (ADR-008 §3, §7).
   *
   * Named exhaustively rather than matched by prefix, because the value of the
   * check below is that a new field carrying a verdict about *this* deployment
   * has to be argued for in a diff to this list. `trusted_measurements` is a list
   * of measurements an operator accepts for someone else's upstream — a policy
   * input, not a verdict the router reached, and certainly not one about itself.
   */
  const TRUST_LIST_OPERATIONS = [
    'Query.trustedMeasurements',
    'Mutation.addTrustedMeasurement',
    'Mutation.updateTrustedMeasurement',
    'Mutation.removeTrustedMeasurement',
  ];

  /**
   * ADR-002: the router publishes evidence and never reports a verdict **about
   * itself**. A field called `verified`, `trusted` or `valid` appearing in this
   * schema would be the design regression the whole product is built to avoid, so
   * the schema is asserted rather than the intent documented.
   *
   * ADR-008 §1 narrows the rule, and narrows it only in the direction the ADR
   * argues for: toward an external upstream there *is* a verifying party and it is
   * this router, so the external vocabulary says so. It says it in the
   * `ExternalEndpointStatus` enum (`VERIFIED` / `DENIED`, rendered as *verified by
   * this router*) and in the trust-list operations above — never in a field name,
   * which is why the assertion below still covers every field on
   * `ExternalEndpoint` itself. A bare `verified: Boolean` there would be exactly
   * the claim ADR-002 refuses.
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
        const path = `${type.name}.${field.name}`;
        if (/verif|attested|untrusted|trusted|valid/i.test(field.name) && !TRUST_LIST_OPERATIONS.includes(path)) {
          offenders.push(path);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('says what an external verdict is about by naming the party, in the enum and nowhere else', async () => {
    const response = await request(server())
      .post('/graphql')
      .set('Cookie', cookies)
      .send({ query: '{ __type(name: "ExternalEndpointStatus") { enumValues { name } } }' })
      .expect(200);

    // The whole of the external vocabulary (ADR-008 §1), in the schema's own
    // lexicographic order. `PENDING` is "no live verdict yet", not "unknown
    // validity", and `DISABLED` is the operator's switch — neither is a statement
    // about an upstream.
    expect(response.body.data.__type.enumValues.map((value: { name: string }) => value.name)).toEqual([
      'DENIED_BY_THIS_ROUTER',
      'DISABLED',
      'PENDING',
      'VERIFIED_BY_THIS_ROUTER',
    ]);
  });
});

/**
 * The same route, for an upstream in somebody else's deployment (SUP-227,
 * ADR-008 §7).
 *
 * This is what lets the inspect panel verify an external endpoint's evidence in
 * the browser: the upstream's platform sends no `Access-Control-Allow-Origin`
 * either, so a console on `console.…` cannot read `partner.…`'s well-known path
 * at all. Relaying is a transport fix and not a trust decision — the document is
 * a JWS over its own bytes, and the page checks it here.
 */
describe('GET /v1/evidence/:endpoint for an external upstream', () => {
  it('serves the upstream’s stored bundle byte for byte, without a key', async () => {
    const id = await registerUpstream({
      name: 'partner-cloud',
      hostname: UPSTREAM,
      status: 'verified',
      evidenceDigestSeen: UPSTREAM_DIGEST,
    });
    await fileUpstreamBundle(id, UPSTREAM_DIGEST);

    const response = await request(server()).get('/v1/evidence/partner-cloud').expect(200);

    expect(createHash('sha256').update(response.text, 'utf8').digest('hex')).toBe(
      createHash('sha256').update(JSON.stringify(bundle), 'utf8').digest('hex'),
    );
    expect(response.body).toEqual(bundle);
  });

  it('carries the same CORS and cache headers, or a browser could not use it', async () => {
    const id = await registerUpstream({
      name: 'partner-cors',
      hostname: `cors.${UPSTREAM}`,
      status: 'verified',
      evidenceDigestSeen: UPSTREAM_DIGEST,
    });
    await fileUpstreamBundle(id, UPSTREAM_DIGEST);

    const response = await request(server()).get('/v1/evidence/partner-cors').set('Origin', CONSOLE_ORIGIN).expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(CONSOLE_ORIGIN);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('says "not fetched yet" before the first poll, rather than denying the upstream', async () => {
    await registerUpstream({
      name: 'newcomer-cloud',
      hostname: UPSTREAM_PENDING,
      status: 'pending',
      evidenceDigestSeen: null,
    });

    const response = await request(server())
      .get('/v1/evidence/newcomer-cloud')
      .set('Origin', CONSOLE_ORIGIN)
      .expect(503);

    // The same typed reason the own-endpoint case uses, so the gate's "waiting"
    // branch covers both without learning a second vocabulary.
    expect(response.body).toMatchObject({ reason: 'evidence_not_fetched' });
    expect(response.body.message).toContain(UPSTREAM_PENDING);
    expect(response.body.version).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBe(CONSOLE_ORIGIN);
  });

  it('404s for an upstream nobody registered', async () => {
    const response = await request(server()).get('/v1/evidence/not-a-partner').expect(404);

    expect(response.body).toMatchObject({ statusCode: 404 });
  });
});
