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

const EMPTY: LocalState = {
  users: [],
  workspaces: [],
  members: [],
  ledger: [],
  inviteCodes: [],
  redemptions: [],
  externalEndpoints: [],
  models: [],
  trustedMeasurements: [],
};

/** A deployment its operator has just claimed: a new id, a personal workspace, the sign-up grant. */
const CLAIMED: LocalState = {
  ...EMPTY,
  users: [{ id: 'op-new', email: OPERATOR }],
  workspaces: [{ id: 'ws-new', slug: 'admin' }],
  members: [{ workspaceId: 'ws-new', userId: 'op-new', role: 'owner' }],
  ledger: [{ id: 'tx-new', idempotencyKey: 'signup:op-new' }],
};

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
      externalEndpoints: [],
      models: [],
      trustedMeasurements: data.trustedMeasurements.map(({ id, measurement }) => ({ id, measurement })),
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
