import { describe, expect, it } from 'vitest';
import { buildBundle, type ExportBundle, type ExportData } from './export-bundle.js';
import {
  bundleInconsistencies,
  type LocalApiKey,
  type LocalExternalEndpoint,
  type LocalInviteCode,
  type LocalModel,
  type LocalState,
  type LocalWorkspace,
  planImport,
  planIsClean,
} from './import-plan.js';

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

function model(
  id: string,
  extra: Partial<ExportData['externalEndpoints'][number]['models'][number]> = {},
): ExportData['externalEndpoints'][number]['models'][number] {
  return {
    id,
    name: id,
    upstreamModel: `upstream/${id}`,
    contextLength: 8192,
    capabilities: ['chat'],
    promptPer1mMicros: '1000000',
    completionPer1mMicros: '2000000',
    enabled: true,
    ...extra,
  };
}

function endpoint(
  id: string,
  extra: Partial<ExportData['externalEndpoints'][number]> = {},
): ExportData['externalEndpoints'][number] {
  return {
    id,
    name: 'partner',
    baseUrl: 'https://llm.partner.example/v1',
    listenPort: 15001,
    enabled: true,
    pinnedEvidenceDigest: null,
    createdByUserId: null,
    createdAt: AT,
    models: [],
    ...extra,
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

/**
 * The local rows as the plan sees them — the projection `DataImportService`
 * reads back out of the database, in the bundle's own units.
 *
 * Built from the exported row wherever one exists, so a deployment that has
 * taken a bundle and changed nothing refreshes nothing: a `toRefresh` in these
 * tests is always something a test put there.
 */
function localWorkspaceOf(row: ExportData['workspaces'][number], extra: Partial<LocalWorkspace> = {}): LocalWorkspace {
  return {
    id: row.id,
    slug: row.slug,
    balanceMicros: row.balanceMicros,
    name: row.name,
    stripeCustomerId: row.stripeCustomerId,
    autoTopUpEnabled: row.autoTopUpEnabled,
    autoTopUpThresholdMicros: row.autoTopUpThresholdMicros,
    autoTopUpAmountMicros: row.autoTopUpAmountMicros,
    autoTopUpLastAt: row.autoTopUpLastAt,
    firstRequestAt: row.firstRequestAt,
    ...extra,
  };
}

function localCodeOf(row: ExportData['inviteCodes'][number], extra: Partial<LocalInviteCode> = {}): LocalInviteCode {
  return {
    id: row.id,
    code: row.value,
    campaign: row.campaign,
    grantMicros: row.grantMicros,
    maxRedemptions: row.maxRedemptions,
    redemptionCount: row.redemptionCount,
    expiresAt: row.expiresAt,
    withdrawnAt: row.withdrawnAt,
    note: row.note,
    ...extra,
  };
}

function localKeyOf(row: ExportData['apiKeys'][number], extra: Partial<LocalApiKey> = {}): LocalApiKey {
  return {
    id: row.id,
    keyHash: row.keyHash,
    name: row.name,
    modelScope: row.modelScope,
    spendLimitMicros: row.spendLimitMicros,
    spentTotalMicros: row.spentTotalMicros,
    requestsPerMinute: row.requestsPerMinute,
    tokensPerMinute: row.tokensPerMinute,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    ...extra,
  };
}

function localEndpointOf(
  row: ExportData['externalEndpoints'][number],
  extra: Partial<LocalExternalEndpoint> = {},
): LocalExternalEndpoint {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    pinnedEvidenceDigest: row.pinnedEvidenceDigest,
    ...extra,
  };
}

function localModelOf(
  row: ExportData['externalEndpoints'][number]['models'][number],
  externalEndpointId: string | null,
  extra: Partial<LocalModel> = {},
): LocalModel {
  return {
    id: row.id,
    externalEndpointId,
    name: row.name,
    upstreamModel: row.upstreamModel,
    contextLength: row.contextLength,
    capabilities: row.capabilities,
    promptPer1mMicros: row.promptPer1mMicros,
    completionPer1mMicros: row.completionPer1mMicros,
    ...extra,
  };
}

/** A row this deployment made itself, named rather than projected from a bundle. */
const ownWorkspace = (id: string, slug: string): LocalWorkspace => localWorkspaceOf({ ...workspace(id, '0'), slug });
const ownKey = (id: string, keyHash: string): LocalApiKey => localKeyOf(apiKey(id, 'ws-qa', keyHash));

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
  workspaces: [ownWorkspace('ws-new', 'admin')],
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
    workspaces: [
      ownWorkspace('ws-new', 'admin'),
      ...data.workspaces.filter((row) => row.id !== 'ws-op').map((row) => localWorkspaceOf(row)),
    ],
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
    inviteCodes: data.inviteCodes.map((row) => localCodeOf(row)),
    redemptions: data.inviteRedemptions.map(({ id, userId }) => ({ id, userId })),
    apiKeys: data.apiKeys.map((row) => localKeyOf(row)),
    externalEndpoints: data.externalEndpoints.map((row) => localEndpointOf(row)),
    models: data.externalEndpoints.flatMap((row) => row.models.map((model) => localModelOf(model, row.id))),
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
    workspaces: [...local.workspaces, ownWorkspace('ws-qa', 'qa')],
    members: [...local.members, { workspaceId: 'ws-qa', userId: 'qa', role: 'owner' }],
    ledger: [...local.ledger, { id: 'tx-qa-spend', idempotencyKey: 'usage:gen-qa-1' }],
    apiKeys: [...local.apiKeys, ownKey('key-qa', 'd4'.repeat(32))],
    // A model of this deployment's own config, which is nobody's drift.
    models: [...local.models, localModelOf(model('cfg-model'), null)],
  };
}

/** The sections of a plan, by name, for an assertion that reads like the console. */
function sectionsOf(plan: ReturnType<typeof planImport>) {
  return Object.fromEntries(plan.sections.map((section) => [section.section, section]));
}

/** `bo` spends `code-2` on the old deployment inside the cutover window. */
function spentByBo(data: ExportData, maxRedemptions = 1): ExportData {
  const code = data.inviteCodes[1] as ExportData['inviteCodes'][number];
  data.inviteCodes[1] = { ...code, maxRedemptions, redemptionCount: 1, status: 'redeemed' };
  data.creditLedger[data.creditLedger.length - 1] = {
    ...(data.creditLedger[data.creditLedger.length - 1] as ExportData['creditLedger'][number]),
    idempotencyKey: 'invite:code-2:bo',
  };
  data.inviteRedemptions.push({
    id: 'red-2',
    inviteCodeId: 'code-2',
    userId: 'bo',
    workspaceId: 'ws-bo',
    creditTransactionId: 'tx-bo',
    redeemedAt: AT,
  });
  return data;
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
        apiKeys: [ownKey('key-else', ADA_KEY_HASH), ownKey('key-op', 'c3'.repeat(32))],
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
      workspaces: data.workspaces.map((row) => localWorkspaceOf(row)),
      members: data.workspaceMembers,
      ledger: data.creditLedger.map(({ id, idempotencyKey }) => ({ id, idempotencyKey })),
      inviteCodes: data.inviteCodes.map((row) => localCodeOf(row)),
      redemptions: data.inviteRedemptions.map(({ id, userId }) => ({ id, userId })),
      apiKeys: data.apiKeys.map((row) => localKeyOf(row)),
      externalEndpoints: [],
      models: [],
      trustedMeasurements: data.trustedMeasurements.map(({ id, measurement }) => ({ id, measurement })),
      priorImports: [],
    };

    const plan = planImport(bundleOf(data), imported, options);

    expect(planIsClean(plan)).toBe(true);
    for (const section of plan.sections) {
      // Nothing to create and nothing to bring up to date: the same file twice
      // says nothing new about any row (SUP-481).
      expect(section, section.section).toMatchObject({ toCreate: 0, alreadyPresent: section.inBundle, toRefresh: 0 });
    }
    expect(plan.touchedWorkspaceIds).toEqual([]);
    expect(plan.modelWrites).toEqual([]);
    expect(Object.values(plan.refreshes).flat()).toEqual([]);
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
    data.externalEndpoints.push(endpoint('ep-1'));
    const reissued = { ...(exported().inviteCodes[1] as ExportData['inviteCodes'][number]), id: 'code-else' };
    const plan = planImport(
      bundleOf(data),
      {
        ...EMPTY,
        workspaces: [ownWorkspace('ws-else', 'ws-ada')],
        inviteCodes: [localCodeOf(reissued)],
        externalEndpoints: [localEndpointOf(endpoint('ep-else'))],
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
    data.externalEndpoints.push(endpoint('ep-1', { pinnedEvidenceDigest: 'sha256/x', createdByUserId: 'op-old' }));

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
    // Nothing about the rows that are here has moved in this file, and what is
    // here only is never brought up to date by one.
    expect(Object.values(plan.refreshes).flat()).toEqual([]);
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

  it('spends the seat the old deployment spent, so a used code cannot be redeemed again here', () => {
    // The invited-launch case: a single-use code fully spent on the old
    // deployment inside the window. Carried as a redemption row but with the
    // counter frozen, the seat came back — and the seat gate is the counter.
    const plan = planImport(bundleOf(spentByBo(withDrift(exported()))), verifiedBy(importedInto(exported())), options);

    expect(planIsClean(plan)).toBe(true);
    expect(sectionsOf(plan).inviteCodes).toMatchObject({ inBundle: 2, alreadyPresent: 2, toRefresh: 1, localOnly: 0 });
    expect(plan.refreshes.inviteCodes).toEqual([
      { id: 'code-2', changes: expect.objectContaining({ redemptionCount: 1, maxRedemptions: 1 }) },
    ]);
    // The redemption row travels with it, and nothing else about the code moves.
    expect(plan.writes.inviteRedemptions.map((row) => row.id)).toEqual(['red-2']);
  });

  it('counts the seats spent on both deployments, so the verification’s own redemption is not resold', () => {
    // Two seats: one spent here during the verification, one spent there inside
    // the window. Assigning the exported count would put the first back on sale.
    const local = verifiedBy(importedInto(exported()));
    const here: LocalState = {
      ...local,
      inviteCodes: local.inviteCodes.map((code) =>
        code.id === 'code-2' ? { ...code, maxRedemptions: 2, redemptionCount: 1 } : code,
      ),
      redemptions: [...local.redemptions, { id: 'red-qa', userId: 'qa' }],
    };

    const plan = planImport(bundleOf(spentByBo(withDrift(exported()), 2)), here, options);

    expect(planIsClean(plan)).toBe(true);
    expect(plan.refreshes.inviteCodes).toEqual([
      { id: 'code-2', changes: expect.objectContaining({ redemptionCount: 2, maxRedemptions: 2 }) },
    ]);
  });

  it('says so when a code was redeemed on both deployments past its seats', () => {
    const local = verifiedBy(importedInto(exported()));
    const here: LocalState = {
      ...local,
      inviteCodes: local.inviteCodes.map((code) => (code.id === 'code-2' ? { ...code, redemptionCount: 1 } : code)),
      redemptions: [...local.redemptions, { id: 'red-qa', userId: 'qa' }],
    };

    const plan = planImport(bundleOf(spentByBo(withDrift(exported()))), here, options);

    expect(plan.refreshes.inviteCodes[0]?.changes.redemptionCount).toBe(2);
    expect(plan.notes.join(' ')).toContain('code-2');
    expect(plan.notes.join(' ')).toContain('past the seats they have');
    // Still importable: the grants are already made and the ledger carries them.
    expect(planIsClean(plan)).toBe(true);
  });

  it('withdraws a code the operator withdrew on either deployment', () => {
    const data = exported();
    data.inviteCodes[1] = { ...(data.inviteCodes[1] as ExportData['inviteCodes'][number]), withdrawnAt: AT };
    const local = importedInto(exported());
    const here: LocalState = {
      ...local,
      // Withdrawn *here* after the import, and the file still says live.
      inviteCodes: local.inviteCodes.map((code) =>
        code.id === 'code-1' ? { ...code, withdrawnAt: '2026-10-05T00:00:00.000Z' } : code,
      ),
    };

    const plan = planImport(bundleOf(data), here, options);

    expect(plan.refreshes.inviteCodes).toEqual([
      { id: 'code-2', changes: expect.objectContaining({ withdrawnAt: AT }) },
    ]);
  });

  it('keeps a key revoked on either deployment revoked', () => {
    const data = exported();
    const revoked = '2026-10-02T00:00:00.000Z';
    data.apiKeys[0] = { ...(data.apiKeys[0] as ExportData['apiKeys'][number]), revokedAt: revoked };
    const local = importedInto(exported());
    const here: LocalState = {
      ...local,
      // Revoked here after the import; the export still has it live.
      apiKeys: local.apiKeys.map((key) => (key.id === 'key-op' ? { ...key, revokedAt: revoked } : key)),
    };

    const plan = planImport(bundleOf(data), here, options);

    expect(planIsClean(plan)).toBe(true);
    // The one the old deployment revoked arrives revoked…
    expect(plan.refreshes.apiKeys).toEqual([
      { id: 'key-ada', changes: expect.objectContaining({ revokedAt: revoked }) },
    ]);
    // …and the one revoked here is left alone rather than brought back to life.
    expect(plan.refreshes.apiKeys.map((row) => row.id)).not.toContain('key-op');
  });

  it('never moves a key’s spend counter or its last use backwards', () => {
    const data = exported();
    data.apiKeys[0] = { ...(data.apiKeys[0] as ExportData['apiKeys'][number]), spendLimitMicros: '20000000' };
    const local = importedInto(exported());
    const ahead = '2026-10-06T00:00:00.000Z';
    const here: LocalState = {
      ...local,
      // The verification spent against this very key, so the counter here is ahead.
      apiKeys: local.apiKeys.map((key) =>
        key.id === 'key-ada' ? { ...key, spentTotalMicros: '9900000', lastUsedAt: ahead } : key,
      ),
    };

    const plan = planImport(bundleOf(data), here, options);

    expect(plan.refreshes.apiKeys).toEqual([
      {
        id: 'key-ada',
        changes: expect.objectContaining({
          // The limit is the source's to state…
          spendLimitMicros: '20000000',
          // …the counter and the last use are not.
          spentTotalMicros: '9900000',
          lastUsedAt: ahead,
        }),
      },
    ]);
  });

  it('never refreshes through a mapping, and refreshes a workspace renamed on the source', () => {
    const data = exported();
    // The operator's workspace is folded into the one they own here, which has
    // this deployment's own name; ada's is her own row under its own id.
    data.workspaces[0] = { ...(data.workspaces[0] as ExportData['workspaces'][number]), name: 'Renamed operator' };
    data.workspaces[1] = { ...(data.workspaces[1] as ExportData['workspaces'][number]), name: 'Ada Ltd' };

    const plan = planImport(bundleOf(data), importedInto(exported()), options);

    expect(plan.refreshes.workspaces).toEqual([
      { id: 'ws-ada', changes: expect.objectContaining({ name: 'Ada Ltd' }) },
    ]);
    // A refreshed workspace has its cached balance re-summed like any other.
    expect(plan.touchedWorkspaceIds).toContain('ws-ada');
  });

  it('adds a model to an endpoint already here, and carries the digest the operator re-approved', () => {
    const first = exported();
    first.externalEndpoints.push(endpoint('ep-1', { models: [model('m-1')], pinnedEvidenceDigest: 'sha256/old' }));
    const later = exported();
    later.externalEndpoints.push(
      endpoint('ep-1', {
        baseUrl: 'https://llm.partner.example/v2',
        pinnedEvidenceDigest: 'sha256/new',
        models: [model('m-1', { promptPer1mMicros: '1500000' }), model('m-2')],
      }),
    );

    const plan = planImport(bundleOf(later), importedInto(first), options);

    expect(planIsClean(plan)).toBe(true);
    expect(sectionsOf(plan).externalEndpoints).toMatchObject({ alreadyPresent: 1, toCreate: 0, toRefresh: 1 });
    // Per model, not per list: the new one is written and counted as created.
    expect(sectionsOf(plan).externalModels).toMatchObject({
      inBundle: 2,
      toCreate: 1,
      alreadyPresent: 1,
      toRefresh: 1,
    });
    expect(plan.modelWrites).toEqual([expect.objectContaining({ id: 'm-2', externalEndpointId: 'ep-1' })]);
    expect(plan.refreshes.externalModels).toEqual([
      { id: 'm-1', changes: expect.objectContaining({ promptPer1mMicros: '1500000' }) },
    ]);
    expect(plan.refreshes.externalEndpoints).toEqual([
      { id: 'ep-1', changes: { baseUrl: 'https://llm.partner.example/v2', pinnedEvidenceDigest: 'sha256/new' } },
    ]);
  });

  it('leaves the operator’s own approval and model switch alone while the upstream stays put', () => {
    // After runbook step 6 the operator has configured this endpoint by hand
    // here: the digest they approved and the models they switched on are theirs,
    // and an export that never moved the upstream says nothing about either.
    const first = exported();
    first.externalEndpoints.push(endpoint('ep-1', { models: [model('m-1')], pinnedEvidenceDigest: 'sha256/old' }));
    const later = exported();
    later.externalEndpoints.push(
      endpoint('ep-1', { models: [model('m-1', { enabled: false })], pinnedEvidenceDigest: 'sha256/old' }),
    );
    const local = importedInto(first);
    const here: LocalState = {
      ...local,
      externalEndpoints: local.externalEndpoints.map((row) =>
        row.id === 'ep-1' ? { ...row, pinnedEvidenceDigest: 'sha256/approved-here' } : row,
      ),
    };

    const plan = planImport(bundleOf(later), here, options);

    expect(planIsClean(plan)).toBe(true);
    // Neither the pin nor the switch is the file's to move.
    expect(plan.refreshes.externalEndpoints).toEqual([]);
    expect(plan.refreshes.externalModels).toEqual([]);
  });

  it('carries the approval of an upstream that moved, and withdraws one it moved without', () => {
    const first = exported();
    first.externalEndpoints.push(endpoint('ep-1', { pinnedEvidenceDigest: 'sha256/old' }));
    const local = importedInto(first);

    const approved = exported();
    approved.externalEndpoints.push(
      endpoint('ep-1', { baseUrl: 'https://llm.partner.example/v2', pinnedEvidenceDigest: 'sha256/new' }),
    );
    expect(planImport(bundleOf(approved), local, options).refreshes.externalEndpoints).toEqual([
      { id: 'ep-1', changes: { baseUrl: 'https://llm.partner.example/v2', pinnedEvidenceDigest: 'sha256/new' } },
    ]);

    // Re-pointed with nothing approved for the new address: the pin goes, the
    // same way an operator's own re-point withdraws it (SUP-435).
    const unapproved = exported();
    unapproved.externalEndpoints.push(
      endpoint('ep-1', { baseUrl: 'https://llm.partner.example/v2', pinnedEvidenceDigest: null }),
    );
    expect(planImport(bundleOf(unapproved), local, options).refreshes.externalEndpoints).toEqual([
      { id: 'ep-1', changes: { baseUrl: 'https://llm.partner.example/v2', pinnedEvidenceDigest: null } },
    ]);
  });

  it('refuses a model this deployment’s own configuration already holds under that id', () => {
    // The endpoint is here from the first import; the later export adds a model
    // to it whose id is a `config` row of this deployment's own router.yaml.
    const first = exported();
    first.externalEndpoints.push(endpoint('ep-1'));
    const later = exported();
    later.externalEndpoints.push(endpoint('ep-1', { models: [model('m-1')] }));
    const local = importedInto(first);

    const plan = planImport(bundleOf(later), { ...local, models: [localModelOf(model('m-1'), null)] }, options);

    expect(planIsClean(plan)).toBe(false);
    expect(sectionsOf(plan).externalModels?.conflicts.join(' ')).toContain('own configuration');
    expect(plan.modelWrites).toEqual([]);
  });

  it('says that an import never withdraws a trust entry of its own', () => {
    const local = importedInto(exported());
    const plan = planImport(
      bundleOf(exported()),
      {
        ...local,
        trustedMeasurements: [...local.trustedMeasurements, { id: 'tm-here', measurement: 'ef'.repeat(32) }],
      },
      options,
    );

    expect(sectionsOf(plan).trustedMeasurements).toMatchObject({ localOnly: 1 });
    expect(plan.notes.join(' ')).toContain('never removes a trust entry');
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
