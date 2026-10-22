import { describe, expect, it } from 'vitest';
import { buildBundle, type ExportBundle, type ExportData } from './export-bundle.js';
import { bundleInconsistencies, type LocalState, planImport, planIsClean } from './import-plan.js';

const AT = '2026-10-01T00:00:00.000Z';
const OPERATOR = 'admin@router.test';

function workspace(id: string, balanceMicros: string): ExportData['workspaces'][number] {
  return {
    id,
    name: id,
    slug: id,
    balanceMicros,
    stripeCustomerId: null,
    autoTopUpEnabled: false,
    autoTopUpThresholdMicros: null,
    autoTopUpAmountMicros: null,
    autoTopUpLastAt: null,
    firstRequestAt: null,
    createdAt: AT,
  };
}

function user(id: string, email: string): ExportData['users'][number] {
  return {
    id,
    email,
    name: id,
    emailVerified: true,
    image: null,
    createdAt: AT,
    role: 'user',
    origin: 'open',
    invitedByCodeId: null,
  };
}

function entry(id: string, workspaceId: string, [amountMicros, idempotencyKey]: [string, string]) {
  return {
    id,
    workspaceId,
    kind: 'grant' as const,
    amountMicros,
    reference: null,
    description: null,
    idempotencyKey,
    createdAt: AT,
  };
}

function apiKey(id: string, workspaceId: string, hash: string): ExportData['apiKeys'][number] {
  return {
    id,
    workspaceId,
    name: `${id} key`,
    keyHash: hash,
    prefix: 'sk-tee-v1-4f',
    purpose: null,
    modelScope: null,
    spendLimitMicros: '10000000',
    spentTotalMicros: '9500000',
    requestsPerMinute: null,
    tokensPerMinute: null,
    expiresAt: null,
    lastUsedAt: AT,
    revokedAt: null,
    createdByUserId: null,
    createdAt: AT,
  };
}

const ADA_KEY_HASH = 'a1'.repeat(32);
const OP_KEY_HASH = 'b2'.repeat(32);

/** The operator with a sign-up grant, and one invited account that spent its code. */
function exported(): ExportData {
  return {
    users: [user('op-old', OPERATOR), user('ada', 'ada@example.test')],
    workspaces: [workspace('ws-op', '20000000'), workspace('ws-ada', '100000000')],
    workspaceMembers: [
      { workspaceId: 'ws-op', userId: 'op-old', role: 'owner', createdAt: AT },
      { workspaceId: 'ws-ada', userId: 'ada', role: 'owner', createdAt: AT },
    ],
    creditLedger: [
      entry('tx-op', 'ws-op', ['20000000', 'signup:op-old']),
      entry('tx-ada', 'ws-ada', ['100000000', 'invite:code-1:ada']),
    ],
    inviteCodes: [
      {
        id: 'code-1',
        value: 'AAAABBBBCCCC',
        campaign: 'launch',
        grantMicros: '100000000',
        maxRedemptions: 1,
        redemptionCount: 1,
        status: 'redeemed',
        expiresAt: null,
        withdrawnAt: null,
        note: null,
        issuedByUserId: 'op-old',
        createdAt: AT,
      },
      {
        id: 'code-2',
        value: 'DDDDEEEEFFFF',
        campaign: 'launch',
        grantMicros: '100000000',
        maxRedemptions: 1,
        redemptionCount: 0,
        status: 'unredeemed',
        expiresAt: null,
        withdrawnAt: null,
        note: null,
        issuedByUserId: 'op-old',
        createdAt: AT,
      },
    ],
    inviteRedemptions: [
      {
        id: 'red-1',
        inviteCodeId: 'code-1',
        userId: 'ada',
        workspaceId: 'ws-ada',
        creditTransactionId: 'tx-ada',
        redeemedAt: AT,
      },
    ],
    apiKeys: [apiKey('key-ada', 'ws-ada', ADA_KEY_HASH), apiKey('key-op', 'ws-op', OP_KEY_HASH)],
    externalEndpoints: [],
    trustedMeasurements: [
      { id: 'tm-1', measurement: 'ab'.repeat(32), note: null, addedByUserId: 'op-old', addedAt: AT },
    ],
  };
}

function bundleOf(data: ExportData): ExportBundle {
  return buildBundle({
    data,
    exportedAt: new Date(AT),
    source: { publicBaseUrl: 'https://old.router.test', routerVersion: '0.17.0', evidenceDigest: null },
  });
}

const SOURCE_URL = 'https://old.router.test';

const EMPTY: LocalState = {
  users: [],
  workspaces: [],
  members: [],
  ledger: [],
  inviteCodes: [],
  redemptions: [],
  apiKeys: [],
  externalEndpoints: [],
  models: [],
  trustedMeasurements: [],
  priorImports: [],
};

/** A deployment its operator has just claimed: a new id, a personal workspace, the sign-up grant. */
const CLAIMED: LocalState = {
  ...EMPTY,
  users: [{ id: 'op-new', email: OPERATOR }],
  workspaces: [{ id: 'ws-new', slug: 'admin' }],
  members: [{ workspaceId: 'ws-new', userId: 'op-new', role: 'owner' }],
  ledger: [{ id: 'tx-new', idempotencyKey: 'signup:op-new' }],
};

/**
 * The deployment the bundle has already been imported into, operator mapped and
 * all — the state the second import of a cutover actually meets (SUP-481).
 */
function importedInto(data: ExportData, extra: Partial<LocalState> = {}): LocalState {
  return {
    users: [{ id: 'op-new', email: OPERATOR }, ...data.users.filter((user) => user.email !== OPERATOR)],
    workspaces: [{ id: 'ws-new', slug: 'admin' }, ...data.workspaces.filter((row) => row.id !== 'ws-op')],
    members: [
      { workspaceId: 'ws-new', userId: 'op-new', role: 'owner' },
      ...data.workspaceMembers.filter((row) => row.userId !== 'op-old'),
    ],
    ledger: [
      { id: 'tx-new', idempotencyKey: 'signup:op-new' },
      ...data.creditLedger
        .filter((row) => row.id !== 'tx-op')
        .map(({ id, idempotencyKey }) => ({ id, idempotencyKey })),
    ],
    inviteCodes: data.inviteCodes.map(({ id, value }) => ({ id, code: value })),
    redemptions: data.inviteRedemptions.map(({ id, userId }) => ({ id, userId })),
    apiKeys: data.apiKeys.map(({ id, keyHash }) => ({ id, keyHash })),
    externalEndpoints: [],
    models: [],
    trustedMeasurements: data.trustedMeasurements.map(({ id, measurement }) => ({ id, measurement })),
    priorImports: [{ sourcePublicBaseUrl: SOURCE_URL, bundleExportedAt: AT, importedAt: '2026-10-01T01:00:00.000Z' }],
    ...extra,
  };
}

/** The account QA signs up on the new deployment to verify it before the cutover. */
function verifiedBy(local: LocalState): LocalState {
  return {
    ...local,
    users: [...local.users, { id: 'qa', email: 'qa@example.test' }],
    workspaces: [...local.workspaces, { id: 'ws-qa', slug: 'qa' }],
    members: [...local.members, { workspaceId: 'ws-qa', userId: 'qa', role: 'owner' }],
    ledger: [...local.ledger, { id: 'tx-qa-spend', idempotencyKey: 'usage:gen-qa-1' }],
    apiKeys: [...local.apiKeys, { id: 'key-qa', keyHash: 'd4'.repeat(32) }],
    // A model of this deployment's own config, which is nobody's drift.
    models: [...local.models, { id: 'cfg-model', externalEndpointId: null }],
  };
}

/** One sign-up the old deployment took after the first export: the drift to catch up. */
function withDrift(data: ExportData): ExportData {
  data.users.push(user('bo', 'bo@example.test'));
  data.workspaces.push(workspace('ws-bo', '7000000'));
  data.workspaceMembers.push({ workspaceId: 'ws-bo', userId: 'bo', role: 'owner', createdAt: AT });
  data.creditLedger.push(entry('tx-bo', 'ws-bo', ['7000000', 'signup:bo']));
  return data;
}

const options = { operatorEmails: [OPERATOR] };

describe('planImport', () => {
  it('creates every row in an empty deployment', () => {
    const plan = planImport(bundleOf(exported()), EMPTY, options);

    expect(planIsClean(plan)).toBe(true);
    for (const section of plan.sections) {
      expect(section, section.section).toMatchObject({ toCreate: section.inBundle, alreadyPresent: 0, conflicts: [] });
    }
    expect(plan.touchedWorkspaceIds.sort()).toEqual(['ws-ada', 'ws-op']);
  });

  it('merges the exported operator into the account that claimed the deployment', () => {
    const plan = planImport(bundleOf(exported()), CLAIMED, options);

    expect(planIsClean(plan)).toBe(true);
    // The operator and their workspace are here already; only ada is created.
    expect(plan.writes.users.map((row) => row.id)).toEqual(['ada']);
    expect(plan.writes.workspaces.map((row) => row.id)).toEqual(['ws-ada']);
    expect(plan.writes.workspaceMembers).toEqual([
      { workspaceId: 'ws-ada', userId: 'ada', role: 'owner', createdAt: AT },
    ]);
    // The sign-up grant was already made to the operator here: not credited twice.
    expect(plan.writes.creditLedger.map((row) => row.id)).toEqual(['tx-ada']);
    expect(plan.notes.join(' ')).toContain('not credited twice');
    // Attribution follows the operator to the id they have here.
    expect(plan.writes.inviteCodes.every((code) => code.issuedByUserId === 'op-new')).toBe(true);
    expect(plan.writes.trustedMeasurements[0]?.addedByUserId).toBe('op-new');
  });

  it('carries an API key into the workspace it belongs to, limit and counter intact', () => {
    const plan = planImport(bundleOf(exported()), CLAIMED, options);

    expect(planIsClean(plan)).toBe(true);
    expect(plan.writes.apiKeys.map((key) => key.id).sort()).toEqual(['key-ada', 'key-op']);
    expect(plan.writes.apiKeys.find((key) => key.id === 'key-ada')).toMatchObject({
      workspaceId: 'ws-ada',
      keyHash: ADA_KEY_HASH,
      spendLimitMicros: '10000000',
      spentTotalMicros: '9500000',
    });
    // The operator's own key lands in the workspace they own on this deployment.
    expect(plan.writes.apiKeys.find((key) => key.id === 'key-op')).toMatchObject({ workspaceId: 'ws-new' });
    expect(plan.notes.join(' ')).toContain('2 API key(s) are imported, 2 of them still live');
  });

  it('counts a revoked key as imported but not as live', () => {
    const data = exported();
    data.apiKeys = [{ ...apiKey('key-dead', 'ws-ada', ADA_KEY_HASH), revokedAt: AT }];

    const plan = planImport(bundleOf(data), EMPTY, options);

    expect(plan.writes.apiKeys[0]).toMatchObject({ revokedAt: AT });
    expect(plan.notes.join(' ')).toContain('1 API key(s) are imported, 0 of them still live');
  });

  it('reports a credential already registered here, and an id that is a different credential', () => {
    const plan = planImport(
      bundleOf(exported()),
      {
        ...EMPTY,
        apiKeys: [
          { id: 'key-else', keyHash: ADA_KEY_HASH },
          { id: 'key-op', keyHash: 'c3'.repeat(32) },
        ],
      },
      options,
    );

    const conflicts = plan.sections.find((section) => section.section === 'apiKeys')?.conflicts ?? [];
    expect(planIsClean(plan)).toBe(false);
    expect(conflicts).toHaveLength(2);
    // Named by row id: the hash is a verifier and is not echoed into a message.
    expect(conflicts.join(' ')).toContain('key-ada');
    expect(conflicts.join(' ')).toContain('key-op');
    expect(conflicts.join(' ')).not.toContain(ADA_KEY_HASH);
  });

  it('lands a mapped operator’s other ledger entries in the workspace they own here', () => {
    const data = exported();
    data.creditLedger.push(entry('tx-op-2', 'ws-op', ['5000000', 'adjustment:manual-1']));
    (data.workspaces[0] as { balanceMicros: string }).balanceMicros = '25000000';

    const plan = planImport(bundleOf(data), CLAIMED, options);

    expect(planIsClean(plan)).toBe(true);
    expect(plan.writes.creditLedger.find((row) => row.id === 'tx-op-2')).toMatchObject({ workspaceId: 'ws-new' });
    expect(plan.touchedWorkspaceIds).toContain('ws-new');
  });

  it('counts a second run as already present, not as a collision', () => {
    const data = exported();
    const imported: LocalState = {
      users: data.users.map(({ id, email }) => ({ id, email })),
      workspaces: data.workspaces.map(({ id, slug }) => ({ id, slug })),
      members: data.workspaceMembers,
      ledger: data.creditLedger.map(({ id, idempotencyKey }) => ({ id, idempotencyKey })),
      inviteCodes: data.inviteCodes.map(({ id, value }) => ({ id, code: value })),
      redemptions: data.inviteRedemptions.map(({ id, userId }) => ({ id, userId })),
      apiKeys: data.apiKeys.map(({ id, keyHash }) => ({ id, keyHash })),
      externalEndpoints: [],
      models: [],
      trustedMeasurements: data.trustedMeasurements.map(({ id, measurement }) => ({ id, measurement })),
      priorImports: [],
    };

    const plan = planImport(bundleOf(data), imported, options);

    expect(planIsClean(plan)).toBe(true);
    for (const section of plan.sections) {
      expect(section, section.section).toMatchObject({ toCreate: 0, alreadyPresent: section.inBundle });
    }
    expect(plan.touchedWorkspaceIds).toEqual([]);
  });

  it('refuses a deployment with an account that is neither in the export nor an operator’s', () => {
    const plan = planImport(
      bundleOf(exported()),
      { ...CLAIMED, users: [...CLAIMED.users, { id: 'x', email: 'early@example.test' }] },
      options,
    );

    expect(planIsClean(plan)).toBe(false);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toContain('not fresh: 1 account(s)');
  });

  it('refuses an exported address that somebody else already holds here', () => {
    // Same address as an exported account, another id, and not an operator.
    const plan = planImport(
      bundleOf(exported()),
      { ...EMPTY, users: [{ id: 'other', email: 'ADA@example.test' }] },
      options,
    );

    expect(plan.refusals[0]).toContain('not fresh');
  });

  it('reports a taken slug, a reissued code value and a taken endpoint name as conflicts', () => {
    const data = exported();
    data.externalEndpoints.push({
      id: 'ep-1',
      name: 'partner',
      baseUrl: 'https://llm.partner.example/v1',
      listenPort: 15001,
      enabled: true,
      pinnedEvidenceDigest: null,
      createdByUserId: null,
      createdAt: AT,
      models: [],
    });
    const plan = planImport(
      bundleOf(data),
      {
        ...EMPTY,
        workspaces: [{ id: 'ws-else', slug: 'ws-ada' }],
        inviteCodes: [{ id: 'code-else', code: 'DDDDEEEEFFFF' }],
        externalEndpoints: [{ id: 'ep-else', name: 'partner' }],
      },
      options,
    );

    const conflicts = Object.fromEntries(plan.sections.map((section) => [section.section, section.conflicts]));
    expect(planIsClean(plan)).toBe(false);
    expect(conflicts.workspaces).toHaveLength(1);
    expect(conflicts.externalEndpoints).toHaveLength(1);
    expect(conflicts.inviteCodes).toHaveLength(1);
    // A conflict names the row, never the live code.
    expect(conflicts.inviteCodes?.[0]).toContain('code-2');
    expect(conflicts.inviteCodes?.[0]).not.toContain('DDDDEEEEFFFF');
  });

  it('notes that imported endpoints arrive switched off and without a key', () => {
    const data = exported();
    data.externalEndpoints.push({
      id: 'ep-1',
      name: 'partner',
      baseUrl: 'https://llm.partner.example/v1',
      listenPort: 15001,
      enabled: true,
      pinnedEvidenceDigest: 'sha256/x',
      createdByUserId: 'op-old',
      createdAt: AT,
      models: [],
    });

    const plan = planImport(bundleOf(data), CLAIMED, options);

    expect(plan.notes.join(' ')).toContain('switched off and without an upstream API key');
    expect(plan.writes.externalEndpoints[0]?.createdByUserId).toBe('op-new');
  });

  it('takes a later export from the same source and keeps what signed up here since', () => {
    // The cutover's last step (SUP-481): the new deployment has been imported
    // into and then verified by a real sign-up, and the old one has served one
    // more account in the meantime. Both have to survive the same import.
    const plan = planImport(bundleOf(withDrift(exported())), verifiedBy(importedInto(exported())), options);
    const sections = Object.fromEntries(plan.sections.map((section) => [section.section, section]));

    expect(plan.refusals).toEqual([]);
    expect(planIsClean(plan)).toBe(true);
    // Only the drift is written.
    expect(plan.writes.users.map((row) => row.id)).toEqual(['bo']);
    expect(plan.writes.workspaces.map((row) => row.id)).toEqual(['ws-bo']);
    expect(plan.writes.creditLedger.map((row) => row.id)).toEqual(['tx-bo']);
    expect(plan.writes.apiKeys).toEqual([]);
    expect(plan.touchedWorkspaceIds).toEqual(['ws-bo']);
    // And QA's account, its workspace, its membership, its spend and its key are
    // counted as kept rather than refused.
    expect(sections.users).toMatchObject({ toCreate: 1, alreadyPresent: 2, localOnly: 1 });
    expect(sections.workspaces).toMatchObject({ localOnly: 1 });
    expect(sections.workspaceMembers).toMatchObject({ localOnly: 1 });
    expect(sections.creditLedger).toMatchObject({ localOnly: 1 });
    expect(sections.apiKeys).toMatchObject({ inBundle: 2, toCreate: 0, alreadyPresent: 2, localOnly: 1 });
    // A config-born model is a projection of router.yaml, not drift.
    expect(sections.externalModels).toMatchObject({ localOnly: 0 });
    expect(plan.notes.join(' ')).toContain('1 account(s) here are not in the export');
    expect(plan.lastImport?.sourcePublicBaseUrl).toBe(SOURCE_URL);
  });

  it('recognises the dataset it holds even with no record of having imported it', () => {
    // Imported by a build older than `data_imports`, or from a deployment that
    // was renamed between the two exports: the ids here are the evidence.
    const local = verifiedBy(importedInto(exported(), { priorImports: [] }));

    const plan = planImport(bundleOf(withDrift(exported())), local, options);

    expect(plan.refusals).toEqual([]);
    expect(plan.lastImport).toBeNull();
    expect(plan.writes.users.map((row) => row.id)).toEqual(['bo']);
  });

  it('refuses a deployment whose own accounts came from somewhere else', () => {
    const plan = planImport(
      bundleOf(exported()),
      {
        ...CLAIMED,
        users: [...CLAIMED.users, { id: 'qa', email: 'qa@example.test' }],
        priorImports: [{ sourcePublicBaseUrl: 'https://other.router.test', bundleExportedAt: AT, importedAt: AT }],
      },
      options,
    );

    expect(planIsClean(plan)).toBe(false);
    expect(plan.refusals[0]).toContain('nothing here came from this export’s deployment');
  });

  it('refuses to merge an exported address another account here holds', () => {
    const local = verifiedBy(importedInto(exported()));

    const plan = planImport(
      bundleOf(withDrift(exported())),
      { ...local, users: [...local.users, { id: 'bo-local', email: 'BO@example.test' }] },
      options,
    );

    const conflicts = plan.sections.find((section) => section.section === 'users')?.conflicts ?? [];
    expect(planIsClean(plan)).toBe(false);
    expect(conflicts.join(' ')).toContain('held here by another account, bo-local');
    // Named by id: an address is nobody's to echo.
    expect(conflicts.join(' ')).not.toContain('bo@example.test');
    expect(plan.writes.users).toEqual([]);
  });

  it('notes a file no newer than the export already imported here', () => {
    const plan = planImport(bundleOf(exported()), importedInto(exported()), options);

    expect(planIsClean(plan)).toBe(true);
    expect(plan.writes.users).toEqual([]);
    expect(plan.notes.join(' ')).toContain('no later than the export of the same deployment already imported here');
  });
});

describe('bundleInconsistencies', () => {
  it('accepts a bundle that adds up', () => {
    expect(bundleInconsistencies(exported())).toEqual([]);
  });

  it('refuses a balance its own ledger does not add up to', () => {
    const data = exported();
    (data.workspaces[1] as { balanceMicros: string }).balanceMicros = '999000000';

    expect(bundleInconsistencies(data).join(' ')).toContain('do not equal the sum of their ledger entries');
    expect(planIsClean(planImport(bundleOf(data), EMPTY, options))).toBe(false);
  });

  it('refuses a key whose workspace is not in the file, and two keys with one credential', () => {
    const orphaned = exported();
    orphaned.apiKeys = [apiKey('key-ghost', 'ws-gone', ADA_KEY_HASH)];
    expect(bundleInconsistencies(orphaned).join(' ')).toContain(
      'API key(s) belong to a workspace the export does not carry',
    );

    const twinned = exported();
    twinned.apiKeys = [apiKey('key-1', 'ws-ada', ADA_KEY_HASH), apiKey('key-2', 'ws-ada', ADA_KEY_HASH)];
    expect(bundleInconsistencies(twinned).join(' ')).toContain('the same API key hash more than once');
  });

  it('refuses references to rows the export does not carry, and repeated rows', () => {
    const data = exported();
    data.inviteRedemptions[0] = {
      ...(data.inviteRedemptions[0] as ExportData['inviteRedemptions'][number]),
      userId: 'ghost',
    };
    data.users.push(user('ada-2', 'ADA@example.test'));

    const problems = bundleInconsistencies(data).join(' ');
    expect(problems).toContain('redemption(s) name a code, account, workspace or ledger entry');
    expect(problems).toContain('same account address more than once');
  });
});
