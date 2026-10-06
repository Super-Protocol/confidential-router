import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      id name baseUrl hostname enabled status apiKeyPrefix registeredBy
      models { id name upstreamModel contextLength capabilities promptPer1mMicros completionPer1mMicros tee enabled }
    }
  }
`;
const ENDPOINTS = `
  {
    externalEndpoints {
      id name baseUrl hostname enabled status measurementSeen evidenceDigestSeen pinnedCertFingerprint
      apiKeyPrefix registeredBy models { id promptPer1mMicros }
    }
  }
`;
const MEASUREMENTS = '{ trustedMeasurements { id measurement note addedBy addedAt } }';
const EVENTS = `
  query Events($id: ID!) {
    externalEndpointEvents(externalEndpointId: $id) { id kind at stage reason }
  }
`;
const ADD_MEASUREMENT = `
  mutation Add($input: AddTrustedMeasurementInput!) {
    addTrustedMeasurement(input: $input) { id measurement note addedBy }
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
        tee: 'AMD SEV-SNP',
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
      registeredBy: OPERATOR,
    });
    expect(endpoint.models).toEqual([
      {
        id: 'partner/llama-3.3-70b:snp',
        name: 'Llama 3.3 70B (partner)',
        upstreamModel: 'llama-3.3-70b-instruct',
        contextLength: 131072,
        capabilities: ['CHAT'],
        promptPer1mMicros: '400000',
        completionPer1mMicros: '800000',
        tee: 'AMD SEV-SNP',
        enabled: true,
      },
    ]);
  });

  it('writes a registered event the timeline can render', async () => {
    const ops = await operator();
    const endpoint = await register(ops);

    const body = await graphql(ops, EVENTS, { id: endpoint.id });

    expect(body.data.externalEndpointEvents.map((event: { kind: string }) => event.kind)).toEqual(['REGISTERED']);
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
      'mutation Rotate($input: RotateExternalEndpointKeyInput!) { rotateExternalEndpointKey(input: $input) { apiKeyPrefix } }',
      { input: { id: registered.data.registerExternalEndpoint.id, apiKey: 'sk-rotated-value-here' } },
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
      addedBy: OPERATOR,
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

    await graphql(ops, 'mutation Remove($id: ID!) { removeTrustedMeasurement(id: $id) { measurement } }', {
      id: added.data.addTrustedMeasurement.id,
    });

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
    expect(events.data.externalEndpointEvents).toHaveLength(1);
  });

  it('withholds the two operator fields from a non-admin', async () => {
    await register(await operator());

    const endpoints = await graphql(await member(), ENDPOINTS);
    const measurements = await graphql(await member(), MEASUREMENTS);

    expect(endpoints.data.externalEndpoints[0]).toMatchObject({ apiKeyPrefix: null, registeredBy: null });
    expect(measurements.data.trustedMeasurements).toEqual([]);
  });

  it('refuses every mutation to a signed-in non-admin', async () => {
    const endpoint = await register(await operator());
    const reader = await member();

    const mutations: [string, Record<string, unknown>][] = [
      [REGISTER, { input: registration({ name: 'another' }) }],
      [
        'mutation Update($input: UpdateExternalEndpointInput!) { updateExternalEndpoint(input: $input) { id } }',
        { input: { id: endpoint.id, name: 'renamed' } },
      ],
      [
        'mutation Enable($input: SetExternalEndpointEnabledInput!) { setExternalEndpointEnabled(input: $input) { id } }',
        { input: { id: endpoint.id, enabled: false } },
      ],
      [
        'mutation Rotate($input: RotateExternalEndpointKeyInput!) { rotateExternalEndpointKey(input: $input) { id } }',
        { input: { id: endpoint.id, apiKey: 'sk-nope' } },
      ],
      [ADD_MEASUREMENT, { input: { measurement: MEASUREMENT } }],
      [
        'mutation Note($input: UpdateTrustedMeasurementInput!) { updateTrustedMeasurement(input: $input) { id } }',
        { input: { id: 'whatever', note: 'mine now' } },
      ],
      ['mutation Remove($id: ID!) { removeTrustedMeasurement(id: $id) { id } }', { id: 'whatever' }],
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

  it('tells an anonymous caller nothing about an external upstream through the public catalogue', async () => {
    await register(await operator());

    const models = await graphql(
      anonymous(harness),
      '{ models { id name pricing { promptPer1m } endpoint { hostname } } }',
    );

    // The public surface carries no endpoint URL, no trust list and no verdict
    // detail — and today no external model either, because an unverified upstream
    // is not routable. Listing them belongs to SUP-227, which owns the Models
    // page and the `Model` shape; this is the standing check that the anonymous
    // caller gains nothing in the meantime.
    expect(models.errors).toBeUndefined();
    const serialised = JSON.stringify(models.data);
    expect(serialised).not.toContain('partner.example');
    expect(serialised).not.toContain('partner/llama-3.3-70b:snp');
    expect(serialised).not.toContain(MEASUREMENT);
  });
});

describe('enabling, disabling and re-pricing', () => {
  it('disabling drops the endpoint from the rendered config and records the event', async () => {
    const ops = await operator();
    const endpoint = await register(ops);

    const disabled = await graphql(
      ops,
      'mutation Enable($input: SetExternalEndpointEnabledInput!) { setExternalEndpointEnabled(input: $input) { status enabled } }',
      { input: { id: endpoint.id, enabled: false } },
    );

    expect(disabled.data.setExternalEndpointEnabled).toEqual({ status: 'DISABLED', enabled: false });
    expect(readFileSync(configFile, 'utf8')).not.toContain('name: partner-cloud');
    const events = await graphql(ops, EVENTS, { id: endpoint.id });
    expect(events.data.externalEndpointEvents.map((event: { kind: string }) => event.kind)).toEqual([
      'DISABLED',
      'REGISTERED',
    ]);
  });

  it('re-pointing an endpoint puts it back to PENDING', async () => {
    const ops = await operator();
    const endpoint = await register(ops);

    const updated = await graphql(
      ops,
      'mutation Update($input: UpdateExternalEndpointInput!) { updateExternalEndpoint(input: $input) { baseUrl status } }',
      { input: { id: endpoint.id, baseUrl: 'https://elsewhere.example' } },
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
      `mutation Update($input: UpdateExternalEndpointInput!) {
         updateExternalEndpoint(input: $input) { models { id promptPer1mMicros enabled } }
       }`,
      {
        input: {
          id: endpoint.id,
          models: [{ ...registration().models[0], promptPer1mMicros: '500000' }],
        },
      },
    );

    expect(updated.data.updateExternalEndpoint.models).toEqual([
      // Retired, not deleted: generations keep their foreign key.
      { id: 'partner/dropped:snp', promptPer1mMicros: '400000', enabled: false },
      { id: 'partner/llama-3.3-70b:snp', promptPer1mMicros: '500000', enabled: true },
    ]);
  });
});
