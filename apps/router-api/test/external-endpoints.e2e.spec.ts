import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvidenceSnapshot } from '../src/app/db/entities/evidence-snapshot.entity.js';
import { ExternalEndpoint } from '../src/app/db/entities/external-endpoint.entity.js';
import { ExternalEndpointEvent } from '../src/app/db/entities/external-endpoint-event.entity.js';
import { ExternalCatalogService } from '../src/app/external-endpoints/index.js';
import { createHarness, type Harness } from './app-harness.js';
import { anonymous, type ConsoleSession, graphql, post, signIn } from './console.js';

/**
 * The admin GraphQL surface for external endpoints, end to end (ADR-008 §7).
 *
 * Three properties are wiring rather than logic, which is why they are asserted
 * here and not only in the resolver spec:
 *
 *  - **`AdminGuard` is on every mutation and on none of the queries.** The split
 *    is the product decision (ruling 3 on SUP-221): an operator must not be able
 *    to curate external capacity in secret, so a signed-in non-admin reads
 *    everything about the upstream and writes nothing.
 *  - **The upstream API key has no read path.** Not "is not selected by default" —
 *    the field does not exist in the schema, and the plaintext appears in no
 *    response body.
 *  - **A mutation reaches the sidecar.** The rendered config file is what makes a
 *    trust-list edit live on the next check rather than after the TTL, so the test
 *    reads the file the sidecar would.
 */

const OPERATOR = 'ops@example.test';
const MEMBER = 'member@example.test';
const SECRETS_KEY = Buffer.alloc(32, 9).toString('base64url');
const MEASUREMENT = 'a'.repeat(64);
const UPSTREAM_KEY = 'sk-upstream-super-secret-value';

const REGISTER = `
  mutation Register($input: RegisterExternalEndpointInput!) {
    registerExternalEndpoint(input: $input) {
      id name baseUrl hostname enabled status apiKeyPrefix
      models { id name upstreamModel contextLength capabilities pricing { promptPer1m completionPer1m } }
      events { id kind }
      latestEvidence { snapshotId }
    }
  }
`;
const ENDPOINTS = `
  {
    externalEndpoints {
      id name baseUrl hostname enabled status measurementSeen measurementSource evidenceDigestSeen
      pinnedCertFingerprint apiKeyPrefix
      models { id upstreamModel pricing { promptPer1m } }
      events { id kind at stage reason evidence { snapshotId } }
      latestEvidence { snapshotId containerImages workloads { kind name } }
    }
  }
`;
const MEASUREMENTS = '{ trustedMeasurements { id measurement note addedByEmail addedAt admits } }';
const EVENTS = `
  query Events($id: ID!) {
    externalEndpoint(id: $id) { events { id kind at stage reason } }
  }
`;
const ADD_MEASUREMENT = `
  mutation Add($input: AddTrustedMeasurementInput!) {
    addTrustedMeasurement(input: $input) { id measurement note addedByEmail admits }
  }
`;

let harness: Harness;
let dir: string;
let configFile: string;

function registration(overrides: Record<string, unknown> = {}) {
  return {
    name: 'partner-cloud',
    baseUrl: 'https://partner.example:8443/v1',
    apiKey: UPSTREAM_KEY,
    models: [
      {
        id: 'partner/llama-3.3-70b:snp',
        name: 'Llama 3.3 70B (partner)',
        upstreamModel: 'llama-3.3-70b-instruct',
        contextLength: 131072,
        capabilities: ['CHAT'],
        promptPer1mMicros: '400000',
        completionPer1mMicros: '800000',
      },
    ],
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cr-external-'));
  configFile = join(dir, 'gatekeeper', 'config.yaml');
  harness = await createHarness({
    env: {
      CR_API_AUTH__ADMIN_EMAILS: OPERATOR,
      CR_API_SECRETS_KEY: SECRETS_KEY,
      CR_API_EXTERNAL_ENDPOINTS__CONFIG_FILE: configFile,
      // No sidecar is running, so polling would only log a warning every few
      // seconds. Every endpoint stays `pending`, which is what this suite asserts.
      CR_API_EXTERNAL_ENDPOINTS__STATUS_POLL_INTERVAL: '0ms',
    },
  });
});

afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as Harness;
  rmSync(dir, { recursive: true, force: true });
});

async function operator(): Promise<ConsoleSession> {
  return signIn(harness, OPERATOR);
}

async function member(): Promise<ConsoleSession> {
  return signIn(harness, MEMBER);
}

async function register(session: ConsoleSession, overrides: Record<string, unknown> = {}) {
  const body = await graphql(session, REGISTER, { input: registration(overrides) });
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  return body.data.registerExternalEndpoint;
}

describe('me { isAdmin }', () => {
  it('is true for an address the deployment named and false for everyone else', async () => {
    const asOperator = await graphql(await operator(), '{ me { email isAdmin } }');
    const asMember = await graphql(await member(), '{ me { email isAdmin } }');

    expect(asOperator.data.me).toEqual({ email: OPERATOR, isAdmin: true });
    expect(asMember.data.me).toEqual({ email: MEMBER, isAdmin: false });
  });
});

describe('registering an upstream', () => {
  it('records it as pending, with the prices the operator set', async () => {
    const endpoint = await register(await operator());

    expect(endpoint).toMatchObject({
      name: 'partner-cloud',
      // The path is dropped: the sidecar binds an authority.
      baseUrl: 'https://partner.example:8443',
      hostname: 'partner.example',
      enabled: true,
      // No verdict has been read back, so it serves nothing (ADR-008 §8).
      status: 'PENDING',
      apiKeyPrefix: 'sk-upstr',
    });
    expect(endpoint.models).toEqual([
      {
        id: 'partner/llama-3.3-70b:snp',
        name: 'Llama 3.3 70B (partner)',
        upstreamModel: 'llama-3.3-70b-instruct',
        contextLength: 131072,
        capabilities: ['CHAT'],
        pricing: { promptPer1m: '400000', completionPer1m: '800000' },
      },
    ]);
    // Nothing has verified it, so there is no pinned leaf to bind a fetched
    // bundle to and no summary to show (SUP-221 ruling 1 is informational, and
    // the field is nullable for exactly this state).
    expect(endpoint.latestEvidence).toBeNull();
  });

  it('writes a registered event the timeline can render', async () => {
    const ops = await operator();
    const endpoint = await register(ops);

    const body = await graphql(ops, EVENTS, { id: endpoint.id });

    expect(body.data.externalEndpoint.events.map((event: { kind: string }) => event.kind)).toEqual(['REGISTERED']);
  });

  it('renders the sidecar config in the same request, so the edit is live', async () => {
    await register(await operator());

    const rendered = readFileSync(configFile, 'utf8');
    expect(rendered).toContain('name: partner-cloud');
    expect(rendered).toContain('upstream: https://partner.example:8443');
    expect(rendered).toContain('trust: cloud-measurement');
    expect(rendered).toContain('failMode: closed');
    // The one standing check on this file: the upstream key is injected by the
    // egress leg, never written where the sidecar could read it.
    expect(rendered).not.toContain(UPSTREAM_KEY);
  });

  it('refuses a plain-HTTP upstream with a sentence the console can quote', async () => {
    const body = await graphql(await operator(), REGISTER, {
      input: registration({ baseUrl: 'http://partner.example' }),
    });

    // `BAD_REQUEST`, not `BAD_USER_INPUT`: Apollo names a wrapped 400 first and
    // `errors.ts` keeps its own codes (the same expectation `credits.e2e.spec.ts`
    // records).
    expect(body.errors?.[0].extensions).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    expect(body.errors?.[0].message).toMatch(/no channel to bind a verdict to/);
  });

  it('refuses a second endpoint of the same name as a conflict', async () => {
    const ops = await operator();
    await register(ops);

    const body = await graphql(ops, REGISTER, { input: registration({ models: [] }) });

    expect(body.errors?.[0].extensions.code).toBe('CONFLICT');
  });
});

describe('the upstream API key', () => {
  it('is not a field a client can even ask for', async () => {
    const ops = await operator();
    await register(ops);

    const refused = await post(ops, '{ externalEndpoints { apiKey } }');

    // 400, not a null: Apollo rejects the document before a resolver runs,
    // because the field does not exist in the schema.
    expect(refused.status).toBe(400);
    expect(refused.body.errors?.[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it('appears in no response body, at registration or afterwards', async () => {
    const ops = await operator();
    const registered = await graphql(ops, REGISTER, { input: registration() });
    const listed = await graphql(ops, ENDPOINTS);
    const rotated = await graphql(
      ops,
      'mutation Rotate($id: ID!, $input: RotateExternalEndpointKeyInput!) { rotateExternalEndpointKey(id: $id, input: $input) { apiKeyPrefix } }',
      { id: registered.data.registerExternalEndpoint.id, input: { apiKey: 'sk-rotated-value-here' } },
    );

    const serialised = JSON.stringify([registered, listed, rotated]);
    expect(serialised).not.toContain(UPSTREAM_KEY);
    expect(serialised).not.toContain('sk-rotated-value-here');
    expect(rotated.data.rotateExternalEndpointKey.apiKeyPrefix).toBe('sk-rotat');
  });

  it('refuses to store one at all on a deployment with no data key', async () => {
    await harness.close();
    harness = await createHarness({
      env: {
        CR_API_AUTH__ADMIN_EMAILS: OPERATOR,
        CR_API_EXTERNAL_ENDPOINTS__CONFIG_FILE: configFile,
        CR_API_EXTERNAL_ENDPOINTS__STATUS_POLL_INTERVAL: '0ms',
      },
    });

    const body = await graphql(await operator(), REGISTER, { input: registration() });

    // 503 and not 500: the deployment is missing configuration, and the message
    // names the variable an operator has to set.
    expect(body.errors?.[0].extensions.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.errors?.[0].message).toContain('CR_API_SECRETS_KEY');
  });
});

describe('the trust list', () => {
  it('normalises whatever the operator pasted', async () => {
    const ops = await operator();

    const added = await graphql(ops, ADD_MEASUREMENT, {
      input: { measurement: `0x${MEASUREMENT.toUpperCase()}`, note: 'Partner cloud' },
    });

    expect(added.data.addTrustedMeasurement).toMatchObject({
      measurement: MEASUREMENT,
      note: 'Partner cloud',
      addedByEmail: OPERATOR,
      // Nothing has been checked against it yet: `admits` counts what the last
      // verdict saw, not what the next one will.
      admits: 0,
    });
  });

  it('refuses a repeat however it was spelled, and renders the list once', async () => {
    const ops = await operator();
    await graphql(ops, ADD_MEASUREMENT, { input: { measurement: MEASUREMENT } });

    const repeat = await graphql(ops, ADD_MEASUREMENT, { input: { measurement: `sha256:${MEASUREMENT}` } });

    expect(repeat.errors?.[0].extensions.code).toBe('CONFLICT');
    const listed = await graphql(ops, MEASUREMENTS);
    expect(listed.data.trustedMeasurements).toHaveLength(1);
    expect(readFileSync(configFile, 'utf8')).toContain(MEASUREMENT);
  });

  it('refuses something that is not a measurement', async () => {
    const body = await graphql(await operator(), ADD_MEASUREMENT, { input: { measurement: 'not-hex' } });

    expect(body.errors?.[0].extensions).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    expect(body.errors?.[0].message).toMatch(/is not a VM launch measurement/);
  });

  it('withdrawing takes it out of the rendered config, which is the kill switch', async () => {
    const ops = await operator();
    const added = await graphql(ops, ADD_MEASUREMENT, { input: { measurement: MEASUREMENT } });

    const removed = await graphql(ops, 'mutation Remove($id: ID!) { removeTrustedMeasurement(id: $id) }', {
      id: added.data.addTrustedMeasurement.id,
    });

    // `Boolean!`, not the row: the row is gone, and a payload describing it is a
    // description of something that no longer exists.
    expect(removed.data.removeTrustedMeasurement).toBe(true);
    expect(readFileSync(configFile, 'utf8')).not.toContain(MEASUREMENT);
  });
});

describe('transparency scoping (ruling 3)', () => {
  it('lets a signed-in non-admin read the endpoints, the trust list and the timeline', async () => {
    const ops = await operator();
    const endpoint = await register(ops);
    await graphql(ops, ADD_MEASUREMENT, { input: { measurement: MEASUREMENT, note: 'Partner cloud' } });
    const reader = await member();

    const endpoints = await graphql(reader, ENDPOINTS);
    const measurements = await graphql(reader, MEASUREMENTS);
    const events = await graphql(reader, EVENTS, { id: endpoint.id });

    expect(endpoints.errors).toBeUndefined();
    expect(endpoints.data.externalEndpoints[0]).toMatchObject({
      name: 'partner-cloud',
      baseUrl: 'https://partner.example:8443',
      status: 'PENDING',
    });
    expect(measurements.data.trustedMeasurements[0]).toMatchObject({ measurement: MEASUREMENT, note: 'Partner cloud' });
    expect(events.data.externalEndpoint.events).toHaveLength(1);
  });

  it('withholds the two operator fields from a non-admin', async () => {
    await register(await operator());

    const endpoints = await graphql(await member(), ENDPOINTS);
    const measurements = await graphql(await member(), MEASUREMENTS);

    expect(endpoints.data.externalEndpoints[0]).toMatchObject({ apiKeyPrefix: null });
    // What another operator's deployment calls the model is theirs, not this
    // catalogue's — narrowed for the same reason the key prefix is.
    expect(endpoints.data.externalEndpoints[0].models[0].upstreamModel).toBeNull();
    expect(measurements.data.trustedMeasurements).toEqual([]);
  });

  it('refuses every mutation to a signed-in non-admin', async () => {
    const endpoint = await register(await operator());
    const reader = await member();

    const mutations: [string, Record<string, unknown>][] = [
      [REGISTER, { input: registration({ name: 'another' }) }],
      [
        'mutation Update($id: ID!, $input: UpdateExternalEndpointInput!) { updateExternalEndpoint(id: $id, input: $input) { id } }',
        { id: endpoint.id, input: { baseUrl: 'https://mine-now.example' } },
      ],
      [
        'mutation Enable($id: ID!, $input: SetExternalEndpointEnabledInput!) { setExternalEndpointEnabled(id: $id, input: $input) { id } }',
        { id: endpoint.id, input: { enabled: false } },
      ],
      [
        'mutation Rotate($id: ID!, $input: RotateExternalEndpointKeyInput!) { rotateExternalEndpointKey(id: $id, input: $input) { id } }',
        { id: endpoint.id, input: { apiKey: 'sk-nope' } },
      ],
      [ADD_MEASUREMENT, { input: { measurement: MEASUREMENT } }],
      [
        'mutation Note($input: UpdateTrustedMeasurementInput!) { updateTrustedMeasurement(input: $input) { id } }',
        { input: { id: 'whatever', note: 'mine now' } },
      ],
      ['mutation Remove($id: ID!) { removeTrustedMeasurement(id: $id) }', { id: 'whatever' }],
    ];
    const refusals = [];
    for (const [document, variables] of mutations) {
      refusals.push(await graphql(reader, document, variables));
    }

    // Every mutation, not a sample: `AdminGuard` is applied per method here
    // because the queries are deliberately not admin-only, and a method-level
    // decorator is exactly the kind of thing a new mutation forgets.
    expect(refusals.map((body) => body.errors?.[0]?.extensions?.code)).toEqual(
      Array(mutations.length).fill('FORBIDDEN'),
    );
    // Nothing happened: a refused mutation must not have rendered a config either.
    expect(readFileSync(configFile, 'utf8')).not.toContain(MEASUREMENT);
  });

  it('refuses an anonymous caller before it refuses a non-operator', async () => {
    await register(await operator());
    const visitor = anonymous(harness);

    const endpoints = await graphql(visitor, ENDPOINTS);
    const measurements = await graphql(visitor, MEASUREMENTS);

    expect(endpoints.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
    expect(measurements.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('lists an external model to an anonymous caller — name, price and availability, nothing else', async () => {
    await register(await operator());

    const models = await graphql(
      anonymous(harness),
      `{ models { id name origin available tee pricing { promptPer1m }
                  endpoint { hostname } externalUpstream { hostname status } } }`,
    );

    // Ruling 3's own words: the anonymous `models` query lists external models
    // like any other — name, price, availability — and exposes no endpoint URLs,
    // no trust list and no verdict detail. Hiding them would make the public
    // price list misstate where inference happens.
    expect(models.errors).toBeUndefined();
    expect(models.data?.models).toEqual([
      {
        id: 'partner/llama-3.3-70b:snp',
        name: 'Llama 3.3 70B (partner)',
        origin: 'EXTERNAL',
        // Registered a moment ago, so no verdict admits it: listed, not routable.
        available: false,
        tee: null,
        pricing: { promptPer1m: '400000' },
        endpoint: null,
        externalUpstream: null,
      },
    ]);
    const serialised = JSON.stringify(models.data);
    expect(serialised).not.toContain('partner.example');
    expect(serialised).not.toContain(MEASUREMENT);
  });

  it('gives a signed-in non-admin the upstream behind an external model', async () => {
    const endpoint = await register(await operator());
    const dataSource = harness.app.get(DataSource);
    await dataSource.getRepository(ExternalEndpoint).update(
      { id: endpoint.id },
      {
        status: 'verified',
        measurementSeen: MEASUREMENT,
        evidenceDigestSeen: 'sha256/upstream-now',
        lastCheckedAt: new Date('2026-10-06T12:00:00.000Z'),
      },
    );
    // The catalogue is an in-memory map a mutation or the status poll rebuilds;
    // this suite wrote the verdict straight to the row, so it refreshes by hand.
    await harness.app.get(ExternalCatalogService).refresh();

    const models = await graphql(
      await signIn(harness, MEMBER),
      '{ models { id origin available externalUpstream { name hostname status evidenceDigestSeen } } }',
    );

    expect(models.data?.models).toEqual([
      {
        id: 'partner/llama-3.3-70b:snp',
        origin: 'EXTERNAL',
        available: true,
        externalUpstream: {
          name: 'partner-cloud',
          hostname: 'partner.example',
          // The qualifier lives in the enum value, not in a description: it is
          // what a third-party consumer branches on (ADR-008 §1).
          status: 'VERIFIED_BY_THIS_ROUTER',
          evidenceDigestSeen: 'sha256/upstream-now',
        },
      },
    ]);
  });
});

describe('enabling, disabling and re-pricing', () => {
  it('disabling drops the endpoint from the rendered config and records the event', async () => {
    const ops = await operator();
    const endpoint = await register(ops);

    const disabled = await graphql(
      ops,
      'mutation Enable($id: ID!, $input: SetExternalEndpointEnabledInput!) { setExternalEndpointEnabled(id: $id, input: $input) { status enabled } }',
      { id: endpoint.id, input: { enabled: false } },
    );

    expect(disabled.data.setExternalEndpointEnabled).toEqual({ status: 'DISABLED', enabled: false });
    expect(readFileSync(configFile, 'utf8')).not.toContain('name: partner-cloud');
    const events = await graphql(ops, EVENTS, { id: endpoint.id });
    expect(events.data.externalEndpoint.events.map((event: { kind: string }) => event.kind)).toEqual([
      'DISABLED',
      'REGISTERED',
    ]);
  });

  it('re-pointing an endpoint puts it back to PENDING', async () => {
    const ops = await operator();
    const endpoint = await register(ops);

    const updated = await graphql(
      ops,
      'mutation Update($id: ID!, $input: UpdateExternalEndpointInput!) { updateExternalEndpoint(id: $id, input: $input) { baseUrl status } }',
      { id: endpoint.id, input: { baseUrl: 'https://elsewhere.example' } },
    );

    // The row must not keep vouching for a host it no longer names; the status
    // column is what admission reads.
    expect(updated.data.updateExternalEndpoint).toEqual({ baseUrl: 'https://elsewhere.example', status: 'PENDING' });
    expect(readFileSync(configFile, 'utf8')).toContain('upstream: https://elsewhere.example');
  });

  it('re-prices a model and retires one the operator stopped listing', async () => {
    const ops = await operator();
    const endpoint = await register(ops, {
      models: [...registration().models, { ...registration().models[0], id: 'partner/dropped:snp' }],
    });

    const updated = await graphql(
      ops,
      `mutation Update($id: ID!, $input: UpdateExternalEndpointInput!) {
         updateExternalEndpoint(id: $id, input: $input) { models { id pricing { promptPer1m } } }
       }`,
      {
        id: endpoint.id,
        input: { models: [{ ...registration().models[0], promptPer1mMicros: '500000' }] },
      },
    );

    // The dropped model is retired rather than deleted — generations keep their
    // foreign key — and it is no longer part of what the operator lists, which is
    // all `models` reports: the contract's type has no `enabled`, so a reader
    // shown a retired row could not tell it from a model on offer.
    expect(updated.data.updateExternalEndpoint.models).toEqual([
      { id: 'partner/llama-3.3-70b:snp', pricing: { promptPer1m: '500000' } },
    ]);
  });
});

/**
 * The informational evidence summary, through the API the console reads
 * (SUP-221 ruling 1).
 *
 * The verdict columns and the stored publication are written directly rather
 * than driven through a sidecar and a mock evidence host: what fetching and
 * binding a bundle does is `external-evidence.service.spec.ts`, and what is
 * asserted here is the half that only the real schema can answer — that a
 * summary reaches `latestEvidence`, that a timeline entry gets the publication
 * *its own* verdict saw, and that a non-admin sees both.
 */
describe('the evidence summary (SUP-221 ruling 1)', () => {
  const DIGEST_NOW = `sha256/${Buffer.alloc(32, 1).toString('base64url')}`;
  const DIGEST_BEFORE = `sha256/${Buffer.alloc(32, 2).toString('base64url')}`;
  const LEAF = `sha256/${Buffer.alloc(32, 3).toString('base64url')}`;

  function snapshot(externalEndpointId: string, evidenceDigest: string, image: string): EvidenceSnapshot {
    return {
      id: randomUUID(),
      endpointId: null,
      externalEndpointId,
      fetchedAt: new Date('2026-10-06T12:00:00.000Z'),
      issuedAt: new Date('2026-10-06T11:50:00.000Z'),
      evidenceDigest,
      evidenceDigestHex: 'a'.repeat(64),
      certFingerprint: LEAF,
      quoteFormat: 'intel-tdx-quote-v5',
      containerImages: [image],
      chainSummary: [],
      workloads: [{ kind: 'Deployment', name: 'vllm', namespace: 'partner', containers: ['vllm'] }],
      measurements: { MRTD: 'abc123' },
      jws: 'a.b.c',
      bundle: {},
    } as EvidenceSnapshot;
  }

  /** An upstream the sidecar has admitted, with a publication filed for each of two digests. */
  async function verifiedWithEvidence(session: ConsoleSession): Promise<string> {
    const endpoint = await register(session);
    const dataSource = harness.app.get(DataSource);
    await dataSource.getRepository(ExternalEndpoint).update(
      { id: endpoint.id },
      {
        status: 'verified',
        measurementSeen: MEASUREMENT,
        measurementSource: 'registry',
        evidenceDigestSeen: DIGEST_NOW,
        pinnedCertFingerprint: LEAF,
        lastCheckedAt: new Date('2026-10-06T12:00:00.000Z'),
      },
    );
    await dataSource
      .getRepository(EvidenceSnapshot)
      .save([
        snapshot(endpoint.id, DIGEST_NOW, 'ghcr.io/example/vllm@sha256:now'),
        snapshot(endpoint.id, DIGEST_BEFORE, 'ghcr.io/example/vllm@sha256:before'),
      ]);
    await dataSource.getRepository(ExternalEndpointEvent).save({
      id: randomUUID(),
      externalEndpointId: endpoint.id,
      at: new Date('2026-10-06T12:00:00.000Z'),
      kind: 'digest_changed',
      stage: null,
      reason: null,
      measurement: MEASUREMENT,
      evidenceDigest: DIGEST_BEFORE,
    });
    return endpoint.id;
  }

  it('renders what the current verdict saw, and what each timeline entry saw', async () => {
    const ops = await operator();
    await verifiedWithEvidence(ops);

    const [endpoint] = (await graphql(ops, ENDPOINTS)).data.externalEndpoints;

    expect(endpoint.measurementSource).toBe('REGISTRY');
    expect(endpoint.latestEvidence).toMatchObject({
      containerImages: ['ghcr.io/example/vllm@sha256:now'],
      workloads: [{ kind: 'Deployment', name: 'vllm' }],
    });
    // The entry gets the publication *its* verdict saw. Showing today's images
    // beside a DIGEST_CHANGED entry would make the one event cloud-granularity
    // trust exists to surface unreadable.
    const changed = endpoint.events.find((event: { kind: string }) => event.kind === 'DIGEST_CHANGED');
    const registered = endpoint.events.find((event: { kind: string }) => event.kind === 'REGISTERED');
    expect(changed.evidence.snapshotId).not.toBe(endpoint.latestEvidence.snapshotId);
    // A registration names no digest, so there is no publication to attach.
    expect(registered.evidence).toBeNull();
  });

  it('shows it to a signed-in non-admin too, because transparency is the whole point', async () => {
    await verifiedWithEvidence(await operator());

    const [endpoint] = (await graphql(await member(), ENDPOINTS)).data.externalEndpoints;

    // Ruling 3 and ruling 1 together: a reader who cannot see what a cloud-level
    // admission let in cannot check the claim this product sells.
    expect(endpoint.latestEvidence.containerImages).toEqual(['ghcr.io/example/vllm@sha256:now']);
    expect(endpoint.apiKeyPrefix).toBeNull();
  });

  it('counts a trust-list entry as admitting the endpoint whose verdict saw it', async () => {
    const ops = await operator();
    await verifiedWithEvidence(ops);
    await graphql(ops, ADD_MEASUREMENT, { input: { measurement: MEASUREMENT } });

    const [entry] = (await graphql(ops, MEASUREMENTS)).data.trustedMeasurements;

    // What withdrawing this row would drop — read off the last check, which is
    // the only count that does not imply a promise about the next one.
    expect(entry.admits).toBe(1);
  });
});
