import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BundleRefusedError,
  buildBundle,
  CARRIED_NON_CREDENTIAL_PATHS,
  canonicalJson,
  contentSha256,
  credentialShapedKeys,
  decodeBundle,
  type ExportData,
  encodeBundle,
} from './export-bundle.js';

const AT = '2026-10-01T00:00:00.000Z';
const KEY_HASH = 'a1'.repeat(32);

function data(): ExportData {
  return {
    users: [
      {
        id: 'u1',
        email: 'ada@example.test',
        name: 'Ada',
        emailVerified: true,
        image: null,
        createdAt: AT,
        role: 'user',
        origin: 'open',
        invitedByCodeId: null,
      },
    ],
    workspaces: [
      {
        id: 'w1',
        name: 'Ada',
        slug: 'ada',
        balanceMicros: '7000000',
        stripeCustomerId: null,
        autoTopUpEnabled: false,
        autoTopUpThresholdMicros: null,
        autoTopUpAmountMicros: null,
        autoTopUpLastAt: null,
        firstRequestAt: null,
        createdAt: AT,
      },
    ],
    workspaceMembers: [{ workspaceId: 'w1', userId: 'u1', role: 'owner', createdAt: AT }],
    creditLedger: [
      {
        id: 't1',
        workspaceId: 'w1',
        kind: 'grant',
        amountMicros: '7000000',
        reference: 'signup',
        description: null,
        idempotencyKey: 'signup:u1',
        createdAt: AT,
      },
    ],
    inviteCodes: [],
    inviteRedemptions: [],
    apiKeys: [
      {
        id: 'k1',
        workspaceId: 'w1',
        name: 'Production',
        keyHash: KEY_HASH,
        prefix: 'sk-tee-v1-4f',
        purpose: null,
        modelScope: null,
        spendLimitMicros: '5000000',
        spentTotalMicros: '1250000',
        requestsPerMinute: null,
        tokensPerMinute: null,
        expiresAt: null,
        lastUsedAt: AT,
        revokedAt: null,
        createdByUserId: 'u1',
        createdAt: AT,
      },
      {
        id: 'k2',
        workspaceId: 'w1',
        name: 'Retired',
        keyHash: 'f0'.repeat(32),
        prefix: 'sk-tee-v1-9a',
        purpose: 'console_chat',
        modelScope: ['mock/chat:tdx'],
        spendLimitMicros: null,
        spentTotalMicros: '0',
        requestsPerMinute: 60,
        tokensPerMinute: 10_000,
        expiresAt: AT,
        lastUsedAt: null,
        revokedAt: AT,
        createdByUserId: 'u1',
        createdAt: AT,
      },
    ],
    externalEndpoints: [],
    trustedMeasurements: [],
  };
}

const source = { publicBaseUrl: 'https://old.router.test', routerVersion: '0.17.0', evidenceDigest: 'sha256/abc' };
const bundle = () => buildBundle({ data: data(), source, exportedAt: new Date(AT) });
const repack = (value: unknown): Buffer => gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));

function refusal(file: Buffer): string {
  try {
    decodeBundle(file);
  } catch (error) {
    expect(error).toBeInstanceOf(BundleRefusedError);
    return (error as Error).message;
  }
  throw new Error('The bundle was accepted.');
}

describe('canonicalJson', () => {
  it('is independent of key order, so one dataset has one hash', () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }] })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
    expect(contentSha256({ b: 1, a: 2 })).toBe(contentSha256({ a: 2, b: 1 }));
  });
});

describe('buildBundle', () => {
  it('derives the manifest from the data', () => {
    const built = bundle();

    expect(built).toMatchObject({ format: 'router-export', schemaVersion: 1, exportedAt: AT, source });
    expect(built.counts).toMatchObject({ users: 1, workspaces: 1, creditEntries: 1, inviteCodes: 0 });
    // Two keys, one of them revoked: a revoked key is carried, and is not live.
    expect(built.counts).toMatchObject({ apiKeys: 2, apiKeysLive: 1 });
    expect(built.totalBalanceMicros).toBe('7000000');
    expect(built.integrity.contentSha256).toBe(contentSha256(built.data));
  });

  it('refuses to write a credential-shaped field, whatever section it is in', () => {
    const leaking = data();
    (leaking.users[0] as Record<string, unknown>).passwordHash = 'argon2…';

    expect(() => buildBundle({ data: leaking, source, exportedAt: new Date(AT) })).toThrow(/users\[\]\.passwordHash/);
  });
});

describe('credentialShapedKeys', () => {
  it('names password, token, key and ciphertext fields, and lets the ledger’s retry key through', () => {
    expect(
      credentialShapedKeys({
        rows: [{ id: 1, idempotencyKey: 'k', keyHash: 'x', apiKeyCiphertext: 'y', sessionToken: 'z', password: 'p' }],
      }),
    ).toEqual(['rows[].keyHash', 'rows[].apiKeyCiphertext', 'rows[].sessionToken', 'rows[].password']);
    expect(credentialShapedKeys(bundle())).toEqual([]);
  });

  it('excuses the API-key hash where it is carried, and nowhere else', () => {
    // The whole point of a path allowlist: the same column name in another
    // section is still the tripwire it was written to be.
    expect(CARRIED_NON_CREDENTIAL_PATHS).toEqual([
      'apiKeys',
      'apiKeys[].keyHash',
      'apiKeys[].tokensPerMinute',
      'counts.apiKeysLive',
    ]);
    expect(credentialShapedKeys({ apiKeys: [{ id: 'k1', keyHash: 'x' }] })).toEqual([]);
    expect(credentialShapedKeys({ data: { apiKeys: [{ keyHash: 'x' }] } })).toEqual([]);
    expect(credentialShapedKeys({ apiKeys: [{ keyHash: 'x', sessionToken: 'z' }] })).toEqual([
      'apiKeys[].sessionToken',
    ]);
    expect(credentialShapedKeys({ users: [{ keyHash: 'x' }] })).toEqual(['users[].keyHash']);
  });
});

describe('decodeBundle', () => {
  it('round-trips what encodeBundle wrote, hashes included', () => {
    const read = decodeBundle(encodeBundle(bundle()));

    expect(read).toEqual(bundle());
    // The hash arrives byte for byte: that is the whole of "the key still works".
    expect(read.data.apiKeys[0]?.keyHash).toBe(KEY_HASH);
  });

  it('reads a bundle written before the apiKeys section existed', () => {
    // The redeploy exports from the old build and imports into the new one, so
    // this direction is the ordinary case and not a curiosity (SUP-445).
    const raw = JSON.parse(gunzipSync(encodeBundle(bundle())).toString('utf8'));
    delete raw.data.apiKeys;
    delete raw.counts.apiKeys;
    delete raw.counts.apiKeysLive;
    raw.integrity.contentSha256 = contentSha256(raw.data);

    const read = decodeBundle(repack(raw));

    expect(read.data.apiKeys).toEqual([]);
    expect(read.counts).toMatchObject({ apiKeys: 0, apiKeysLive: 0 });
  });

  it('keeps reading a bundle that carries a field this build does not know', () => {
    const raw = JSON.parse(gunzipSync(encodeBundle(bundle())).toString('utf8'));
    raw.data.users[0].locale = 'en-GB';
    raw.integrity.contentSha256 = contentSha256(raw.data);

    expect(decodeBundle(repack(raw)).data.users[0]).not.toHaveProperty('locale');
  });

  it('refuses another schema version before it reads anything else', () => {
    expect(refusal(repack({ format: 'router-export', schemaVersion: 2 }))).toContain('schema version 2');
  });

  it('refuses a file whose contents, counts or total disagree with its manifest', () => {
    const edited = structuredClone(bundle());
    (edited.data.workspaces[0] as { balanceMicros: string }).balanceMicros = '9000000';
    expect(refusal(repack(edited))).toContain('do not match its own SHA-256');

    const miscounted = structuredClone(bundle());
    miscounted.counts.users = 2;
    expect(refusal(repack(miscounted))).toContain('manifest counts');

    const mistotalled = structuredClone(bundle());
    mistotalled.totalBalanceMicros = '1';
    expect(refusal(repack(mistotalled))).toContain('total balance');
  });

  it('refuses what is not an export at all', () => {
    expect(refusal(Buffer.alloc(0))).toContain('empty');
    expect(refusal(Buffer.from('plain text'))).toContain('not a gzip archive');
    expect(refusal(gzipSync(Buffer.from('not json')))).toContain('does not contain JSON');
    expect(refusal(repack({ format: 'something-else', schemaVersion: 1 }))).toContain('not a router export');
    expect(refusal(repack({ ...bundle(), data: { users: 'nope' } }))).toContain('malformed at data.');
  });
});
