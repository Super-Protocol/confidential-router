import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { generationLedgerKey } from '../billing/ledger.keys.js';
import {
  BundleRefusedError,
  buildBundle,
  canonicalJson,
  carriedUsageKey,
  carryUsageForward,
  contentSha256,
  credentialShapedKeys,
  decodeBundle,
  type ExportData,
  type ExportedCreditEntry,
  encodeBundle,
  isCarriedUsage,
  isPerGenerationUsage,
  MAX_ID_LENGTH,
  sourceLabelOf,
} from './export-bundle.js';

const AT = '2026-10-01T00:00:00.000Z';

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

/** A usage debit as `LedgerService.debitGeneration` writes one. */
function debit(input: { generationId: string; micros: string; at: string; workspaceId?: string }): ExportedCreditEntry {
  return {
    id: `t-${input.generationId}`,
    workspaceId: input.workspaceId ?? 'w1',
    kind: 'usage',
    amountMicros: input.micros,
    reference: input.generationId,
    description: null,
    idempotencyKey: generationLedgerKey(input.generationId),
    createdAt: input.at,
  };
}

describe('carryUsageForward', () => {
  const grant = () => data().creditLedger[0] as ExportedCreditEntry;

  /** A carried entry as an earlier migration left one. */
  function carried(input: { workspaceId?: string; month: string; micros: string; at: string }): ExportedCreditEntry {
    const workspaceId = input.workspaceId ?? 'w1';
    return {
      id: carriedUsageKey(workspaceId, input.month),
      workspaceId,
      kind: 'usage',
      amountMicros: input.micros,
      reference: null,
      description: `Metered usage carried over from older.router.test: 3 requests served in ${input.month}.`,
      idempotencyKey: carriedUsageKey(workspaceId, input.month),
      createdAt: input.at,
    };
  }

  it('replaces a month’s per-request debits with one entry for the same money', () => {
    const result = carryUsageForward(
      [
        grant(),
        debit({ generationId: 'gen-1', micros: '-5', at: '2026-10-19T10:00:00.000Z' }),
        debit({ generationId: 'gen-2', micros: '-7', at: '2026-10-20T11:00:00.000Z' }),
        debit({ generationId: 'gen-3', micros: '-4', at: '2026-10-20T09:00:00.000Z' }),
      ],
      'old.router.test',
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(grant());
    expect(result[1]).toEqual({
      id: 'carried-usage:2026-10:w1',
      workspaceId: 'w1',
      kind: 'usage',
      amountMicros: '-16',
      // The whole point: no reference to a generation the bundle does not carry.
      reference: null,
      description:
        'Metered usage carried over from old.router.test: 3 requests served in 2026-10. ' +
        'The per-request log stayed on the deployment that served it.',
      idempotencyKey: 'carried-usage:2026-10:w1',
      // The instant the month's spend stopped, not the first one: the entry is
      // where the Credits list expects the last charge of that month to be.
      createdAt: '2026-10-20T11:00:00.000Z',
    });
  });

  it('keeps the monthly shape, so a bill before a migration is still answerable', () => {
    const result = carryUsageForward(
      [
        debit({ generationId: 'gen-s1', micros: '-300', at: '2026-09-10T10:00:00.000Z' }),
        debit({ generationId: 'gen-s2', micros: '-200', at: '2026-09-28T10:00:00.000Z' }),
        debit({ generationId: 'gen-o1', micros: '-50', at: '2026-10-02T10:00:00.000Z' }),
      ],
      'old.router.test',
    );

    expect(result.map((entry) => [entry.id, entry.amountMicros, entry.createdAt])).toEqual([
      ['carried-usage:2026-09:w1', '-500', '2026-09-28T10:00:00.000Z'],
      ['carried-usage:2026-10:w1', '-50', '2026-10-02T10:00:00.000Z'],
    ]);
    expect(result[0]?.description).toContain('2 requests served in 2026-09');
    expect(result[1]?.description).toContain('1 request served in 2026-10');
  });

  it('buckets by UTC month, as every other total on these screens does', () => {
    // 00:30+02:00 on 1 October is September in UTC.
    const result = carryUsageForward(
      [debit({ generationId: 'gen-1', micros: '-5', at: '2026-10-01T00:30:00+02:00' })],
      'old.router.test',
    );

    expect(result[0]?.id).toBe('carried-usage:2026-09:w1');
  });

  it('collapses per workspace, and deterministically', () => {
    const entries = [
      debit({ generationId: 'gen-b1', micros: '-2', at: '2026-10-20T10:00:00.000Z', workspaceId: 'w2' }),
      debit({ generationId: 'gen-a1', micros: '-3', at: '2026-10-20T10:00:00.000Z', workspaceId: 'w1' }),
    ];

    const result = carryUsageForward(entries, 'old.router.test');
    expect(result.map((entry) => [entry.workspaceId, entry.amountMicros])).toEqual([
      ['w1', '-3'],
      ['w2', '-2'],
    ]);
    // Same dataset in the other order, same bytes — `canonicalJson` only sorts keys.
    expect(canonicalJson(carryUsageForward([...entries].reverse(), 'old.router.test'))).toBe(canonicalJson(result));
  });

  it('leaves every other entry alone, including a usage debit that is not per-request', () => {
    const adjustment: ExportedCreditEntry = {
      id: 't-adj',
      workspaceId: 'w1',
      kind: 'usage',
      amountMicros: '-100',
      reference: null,
      description: 'operator correction',
      idempotencyKey: 'correction:2026-10',
      createdAt: AT,
    };

    expect(carryUsageForward([grant(), adjustment], 'old.router.test')).toEqual([grant(), adjustment]);
    expect(isPerGenerationUsage(adjustment)).toBe(false);
    expect(isPerGenerationUsage(debit({ generationId: 'gen-1', micros: '-1', at: AT }))).toBe(true);
  });

  it('folds an earlier migration’s entry into the month it belongs to', () => {
    const earlier = carried({ month: '2026-10', micros: '-16', at: '2026-10-20T11:00:00.000Z' });
    expect(isCarriedUsage(earlier)).toBe(true);

    const result = carryUsageForward(
      [earlier, debit({ generationId: 'gen-9', micros: '-4', at: '2026-10-21T09:00:00.000Z' })],
      'old.router.test',
    );

    // One row per workspace per month, whatever the deployment's own history: a
    // second under the same id is a bundle no deployment would import.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'carried-usage:2026-10:w1',
      amountMicros: '-20',
      createdAt: '2026-10-21T09:00:00.000Z',
    });
    // The count is this deployment's own requests; the rest is said in words
    // rather than folded into a number it would make wrong.
    expect(result[0]?.description).toBe(
      'Metered usage carried over from old.router.test: 1 request served in 2026-10, plus usage carried from an ' +
        'earlier migration. The per-request log stayed on the deployment that served it.',
    );
  });

  it('leaves an earlier carried entry exactly as it is when its month has nothing new', () => {
    const september = carried({ month: '2026-09', micros: '-16', at: '2026-09-28T11:00:00.000Z' });

    const result = carryUsageForward(
      [grant(), september, debit({ generationId: 'gen-1', micros: '-4', at: '2026-10-02T09:00:00.000Z' })],
      'old.router.test',
    );

    // September is passed through byte for byte — rewriting it would re-date
    // that spend to a deployment which never served a request of it.
    expect(result).toEqual([grant(), september, expect.objectContaining({ id: 'carried-usage:2026-10:w1' })]);
  });

  it('describes the source by host, so the Credits screen does not render it as a receipt link', () => {
    expect(sourceLabelOf('https://api.old.example.com/')).toBe('api.old.example.com');
    expect(sourceLabelOf('https://api.old.example.com:8443')).toBe('api.old.example.com:8443');
    expect(sourceLabelOf('not a url')).toBe('not a url');

    const carried = carryUsageForward(
      [debit({ generationId: 'gen-1', micros: '-5', at: AT })],
      sourceLabelOf('https://api.old.example.com'),
    );
    expect(carried[0]?.description).not.toContain('https://');
  });
});

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
    expect(built.totalBalanceMicros).toBe('7000000');
    expect(built.integrity.contentSha256).toBe(contentSha256(built.data));
  });

  it('refuses to write a usage debit that names a generation the file cannot carry', () => {
    const dangling = data();
    dangling.creditLedger.push(debit({ generationId: 'gen-1', micros: '-5', at: AT }));

    expect(() => buildBundle({ data: dangling, source, exportedAt: new Date(AT) })).toThrow(
      /1 usage debit\(s\) naming a generation/,
    );
  });

  it('refuses to write a composed id that would not fit the column', () => {
    const wide = data();
    const workspaceId = 'w'.repeat(50);
    wide.workspaces.push({
      ...(wide.workspaces[0] as ExportData['workspaces'][number]),
      id: workspaceId,
      slug: 'wide',
    });
    wide.creditLedger.push(debit({ generationId: 'gen-1', micros: '0', at: AT, workspaceId }));

    // `carried-usage:` + `2026-10:` + 50 is 72 > MAX_ID_LENGTH. Named here, where
    // the workspace that caused it can be pointed at, rather than surfacing as a
    // zod error on importing a file this build had just written.
    expect(() =>
      buildBundle({
        data: { ...wide, creditLedger: carryUsageForward(wide.creditLedger, 'old.router.test') },
        source,
        exportedAt: new Date(AT),
      }),
    ).toThrow(new RegExp(`exceeds ${MAX_ID_LENGTH} characters \\(workspace ${workspaceId}\\)`));
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
});

describe('decodeBundle', () => {
  it('round-trips what encodeBundle wrote', () => {
    expect(decodeBundle(encodeBundle(bundle()))).toEqual(bundle());
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
