import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './app-harness.js';
import { anonymous, type ConsoleSession, expectData, graphql, post, signIn } from './console.js';

/**
 * The Profile screen and the one public corner of this schema.
 *
 * Everything else is behind the session guard, so the two things worth asserting
 * end to end are that the guard is actually on, and that the model catalogue —
 * which a router has to be able to advertise before anyone signs up — is
 * actually off.
 */

const ME = `
  query {
    me {
      id
      email
      name
      avatarUrl
      createdAt
      workspaces { id name slug role balanceMicros }
    }
  }
`;

const UPDATE_PROFILE = `
  mutation Rename($input: UpdateProfileInput!) {
    updateProfile(input: $input) { id name email }
  }
`;

const MODELS = `
  query {
    models {
      id
      slug
      name
      tee
      pricing { promptPer1m completionPer1m }
      endpoint { name hostname evidenceState tokensRouted30d }
    }
  }
`;

let harness: Harness;
let session: ConsoleSession;

beforeAll(async () => {
  harness = await createHarness({
    config: {
      version: 1,
      endpoints: [{ name: 'published', hostname: 'router.example.test', tee: 'Intel TDX + H100 CC' }],
      models: [
        {
          id: 'meta/llama-3.3-70b-instruct:tdx',
          name: 'Llama 3.3 70B Instruct',
          litellmModel: 'vllm/llama-3.3-70b-instruct',
          endpoint: 'published',
          contextLength: 131072,
          pricing: { promptPer1mMicros: 280000, completionPer1mMicros: 420000 },
        },
      ],
      // Nothing to poll in this suite; a timer would only add noise.
      evidence: { pollInterval: '0s' },
    },
  });
  session = await signIn(harness, 'viewer@example.com');
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('the viewer', () => {
  it('answers the whole page header in one query', async () => {
    const { me } = await expectData(session, ME);

    expect(me).toMatchObject({ email: 'viewer@example.com', avatarUrl: null });
    expect(new Date(me.createdAt).getTime()).toBeGreaterThan(0);
    expect(me.workspaces).toHaveLength(1);
    expect(me.workspaces[0]).toMatchObject({ slug: 'viewer', role: 'OWNER', balanceMicros: '0' });
  });

  it('carries the role as an enum, so a client cannot compare it against the wrong casing', async () => {
    const { __type } = await expectData(session, '{ __type(name: "WorkspaceRole") { enumValues { name } } }');

    expect((__type.enumValues as { name: string }[]).map((value) => value.name).sort()).toEqual(['MEMBER', 'OWNER']);
  });

  it('is refused, with a code the console can branch on, without a session', async () => {
    const body = await graphql(anonymous(harness), ME);

    expect(body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

describe('updateProfile', () => {
  it('renames the account and the next read sees it', async () => {
    const renamed = await expectData(session, UPDATE_PROFILE, { input: { name: 'Renamed Viewer' } });
    expect(renamed.updateProfile.name).toBe('Renamed Viewer');

    const { me } = await expectData(session, ME);
    expect(me.name).toBe('Renamed Viewer');
  });

  it('refuses a blank name rather than storing one', async () => {
    const body = await graphql(session, UPDATE_PROFILE, { input: { name: '   ' } });

    expect(body.errors).toBeDefined();
    const { me } = await expectData(session, ME);
    expect(me.name).toBe('Renamed Viewer');
  });

  it('is refused without a session', async () => {
    const body = await graphql(anonymous(harness), UPDATE_PROFILE, { input: { name: 'Nobody' } });

    expect(body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

describe('the public model catalogue', () => {
  it('is readable with no session at all', async () => {
    // A router that meters LLM traffic has to be able to say what it routes to,
    // and at what price, before anyone signs up.
    const { models } = await expectData(anonymous(harness), MODELS);

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'meta/llama-3.3-70b-instruct:tdx',
      slug: 'meta/llama-3.3-70b-instruct:tdx',
      tee: 'Intel TDX + H100 CC',
      pricing: { promptPer1m: '280000', completionPer1m: '420000' },
    });
    expect(models[0].endpoint).toMatchObject({
      hostname: 'router.example.test',
      evidenceState: 'NOT_PUBLISHED',
      // No session means no workspace to attribute usage to, so the anonymous
      // reader is told zero rather than somebody else's number.
      tokensRouted30d: 0,
    });
  });

  it('answers `model` for the anonymous caller too, and null for an id it does not know', async () => {
    const data = await expectData(
      anonymous(harness),
      'query M($id: ID!) { known: model(id: $id) { id } unknown: model(id: "no/such") { id } }',
      { id: 'meta/llama-3.3-70b-instruct:tdx' },
    );

    expect(data.known.id).toBe('meta/llama-3.3-70b-instruct:tdx');
    expect(data.unknown).toBeNull();
  });

  it('still refuses the endpoint list, which is workspace-scoped', async () => {
    const body = await graphql(anonymous(harness), '{ endpoints(workspaceId: "any") { id } }');

    expect(body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

describe('error codes', () => {
  it('reports a workspace the caller is not a member of as FORBIDDEN', async () => {
    const stranger = await signIn(harness, 'stranger@example.com');

    const body = await graphql(stranger, 'query E($id: ID!) { endpoints(workspaceId: $id) { id } }', {
      id: session.workspaceId,
    });

    expect(body.errors[0].extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('reports a malformed document as a GraphQL validation failure, not a server fault', async () => {
    // Apollo rejects an unvalidatable document with a 400 before any resolver
    // runs, so this one cannot go through the 200-asserting helper.
    const response = await post(session, '{ me { nosuchfield } }');

    expect(response.status).toBe(400);
    expect(response.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });
});
