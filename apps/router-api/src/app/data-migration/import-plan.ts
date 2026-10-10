import type { ExportBundle, ExportData } from './export-bundle.js';

/**
 * What an import would do, worked out without writing anything (SUP-271).
 *
 * The dry run and the real import are the same computation: `planImport` reads
 * a bundle and a picture of what this deployment already holds, and answers
 * with the rows to create, the rows already here and everything that stands in
 * the way. The import then writes exactly `plan.writes`, so the screen that
 * said "42 accounts" cannot be followed by an import of 41.
 *
 * Three things decide the shape of it:
 *
 *  - **Only a fresh deployment is imported into.** An account that is here and
 *    not in the bundle is a refusal, unless it is an operator's own — somebody
 *    had to sign in to press the button.
 *  - **A retry is not a collision.** A row already present under the same id is
 *    counted and skipped, so an import interrupted between its two halves (the
 *    accounts are written through Better Auth's connection, everything else in
 *    one transaction) is finished by running it again.
 *  - **The operator who claimed the new deployment is the same person as the
 *    operator in the bundle.** The bootstrap account gets a new id here, so the
 *    bundle's account of the same address is *mapped* onto it — its workspace,
 *    ledger and attribution land on the account that is signed in — rather than
 *    refused as a duplicate address.
 */

/** What is already in the database the import would write into. */
export interface LocalState {
  users: readonly { id: string; email: string }[];
  workspaces: readonly { id: string; slug: string }[];
  members: readonly { workspaceId: string; userId: string; role: string }[];
  /** Ledger row id by idempotency key — the two things a ledger row can collide on. */
  ledger: readonly { id: string; idempotencyKey: string }[];
  inviteCodes: readonly { id: string; code: string }[];
  redemptions: readonly { id: string; userId: string }[];
  externalEndpoints: readonly { id: string; name: string }[];
  models: readonly { id: string; externalEndpointId: string | null }[];
  trustedMeasurements: readonly { id: string; measurement: string }[];
}

export interface PlanOptions {
  /** `auth.bootstrapEmail` and `auth.adminEmails`: the accounts a fresh deployment may already hold. */
  operatorEmails: readonly string[];
}

export type SectionName =
  | 'users'
  | 'workspaces'
  | 'workspaceMembers'
  | 'creditLedger'
  | 'inviteCodes'
  | 'inviteRedemptions'
  | 'externalEndpoints'
  | 'externalModels'
  | 'trustedMeasurements';

export interface SectionPlan {
  section: SectionName;
  inBundle: number;
  toCreate: number;
  /** Already here under the same identity — a retry, or the operator's own account. */
  alreadyPresent: number;
  /** Rows that cannot be written as they are. Any one of them refuses the import. */
  conflicts: string[];
}

export interface ImportPlan {
  /** Why this deployment cannot take the bundle at all. Empty when it can. */
  refusals: string[];
  sections: SectionPlan[];
  /** Things the operator should know that do not stop the import. */
  notes: string[];
  writes: ExportData;
  /** Workspaces whose cached balance has to be re-summed from the ledger afterwards. */
  touchedWorkspaceIds: string[];
}

export function planIsClean(plan: ImportPlan): boolean {
  return plan.refusals.length === 0 && plan.sections.every((section) => section.conflicts.length === 0);
}

const lower = (value: string): string => value.trim().toLowerCase();

class Section {
  toCreate = 0;
  alreadyPresent = 0;
  readonly conflicts: string[] = [];

  constructor(
    readonly section: SectionName,
    readonly inBundle: number,
  ) {}

  done(): SectionPlan {
    const { section, inBundle, toCreate, alreadyPresent, conflicts } = this;
    return { section, inBundle, toCreate, alreadyPresent, conflicts };
  }
}

/**
 * Checks the bundle against itself before it is compared with anything.
 *
 * A reference to a row the file does not carry, or a balance its own ledger
 * does not add up to, would import as a foreign-key failure halfway through or —
 * worse — as a balance nobody can account for. Both are refused up front.
 */
export function bundleInconsistencies(data: ExportData): string[] {
  const problems: string[] = [];
  const users = new Set(data.users.map((user) => user.id));
  const workspaces = new Set(data.workspaces.map((workspace) => workspace.id));
  const ledger = new Set(data.creditLedger.map((entry) => entry.id));
  const codes = new Set(data.inviteCodes.map((code) => code.id));
  const missing = (what: string, count: number): void => {
    if (count > 0) {
      problems.push(`${count} ${what}`);
    }
  };

  missing(
    'workspace membership(s) name an account or workspace the export does not carry.',
    data.workspaceMembers.filter((row) => !users.has(row.userId) || !workspaces.has(row.workspaceId)).length,
  );
  missing(
    'ledger entr(y/ies) belong to a workspace the export does not carry.',
    data.creditLedger.filter((row) => !workspaces.has(row.workspaceId)).length,
  );
  missing(
    'redemption(s) name a code, account, workspace or ledger entry the export does not carry.',
    data.inviteRedemptions.filter(
      (row) =>
        !codes.has(row.inviteCodeId) ||
        !users.has(row.userId) ||
        !workspaces.has(row.workspaceId) ||
        !ledger.has(row.creditTransactionId),
    ).length,
  );

  const sums = new Map<string, bigint>();
  for (const entry of data.creditLedger) {
    sums.set(entry.workspaceId, (sums.get(entry.workspaceId) ?? 0n) + BigInt(entry.amountMicros));
  }
  missing(
    'workspace balance(s) do not equal the sum of their ledger entries.',
    data.workspaces.filter((workspace) => (sums.get(workspace.id) ?? 0n) !== BigInt(workspace.balanceMicros)).length,
  );

  const duplicated = (label: string, values: readonly string[]): void => {
    if (new Set(values).size !== values.length) {
      problems.push(`The export lists the same ${label} more than once.`);
    }
  };
  duplicated(
    'account',
    data.users.map((user) => user.id),
  );
  duplicated(
    'account address',
    data.users.map((user) => lower(user.email)),
  );
  duplicated(
    'workspace',
    data.workspaces.map((workspace) => workspace.id),
  );
  duplicated(
    'ledger entry',
    data.creditLedger.map((entry) => entry.id),
  );
  duplicated(
    'invitation code',
    data.inviteCodes.map((code) => code.id),
  );
  return problems;
}

export function planImport(bundle: ExportBundle, local: LocalState, options: PlanOptions): ImportPlan {
  const { data } = bundle;
  const refusals = bundleInconsistencies(data);
  const notes: string[] = [];
  const operators = new Set(options.operatorEmails.map(lower).filter(Boolean));

  // ── accounts ────────────────────────────────────────────────────────────
  const users = new Section('users', data.users.length);
  const bundleUserById = new Map(data.users.map((user) => [user.id, user]));
  const localUserById = new Map(local.users.map((user) => [user.id, user]));
  const localUserByEmail = new Map(local.users.map((user) => [lower(user.email), user]));

  const strangers = local.users.filter((user) => {
    const sameId = bundleUserById.get(user.id);
    if (sameId) {
      return false; // judged below, as a row of the bundle
    }
    return !operators.has(lower(user.email));
  });
  if (strangers.length > 0) {
    refusals.push(
      `This deployment is not fresh: ${strangers.length} account(s) exist here that are neither in the export nor ` +
        'an operator’s own. An export is only imported into a deployment nobody has signed up to yet.',
    );
  }

  /** Bundle account id → the id it has here, for an operator who re-claimed the deployment. */
  const userIds = new Map<string, string>();
  const userWrites: ExportData['users'] = [];
  for (const user of data.users) {
    const sameId = localUserById.get(user.id);
    const sameEmail = localUserByEmail.get(lower(user.email));
    if (sameId) {
      if (lower(sameId.email) === lower(user.email)) {
        users.alreadyPresent += 1;
      } else {
        users.conflicts.push(`Account ${user.id} exists here under a different address.`);
      }
    } else if (sameEmail) {
      // Not a stranger (those were refused above), so an operator's own account.
      userIds.set(user.id, sameEmail.id);
      users.alreadyPresent += 1;
    } else {
      users.toCreate += 1;
      userWrites.push(user);
    }
  }
  if (userIds.size > 0) {
    notes.push(
      `${userIds.size} operator account(s) already exist here under a new id; the exported account of the same ` +
        'address is merged into each, with its workspace, balance and attribution.',
    );
  }
  const userIdOf = (value: string): string => userIds.get(value) ?? value;
  const userIdOrNull = (value: string | null): string | null => (value === null ? null : userIdOf(value));

  // ── workspaces ──────────────────────────────────────────────────────────
  const workspaces = new Section('workspaces', data.workspaces.length);
  const localWorkspaceIds = new Set(local.workspaces.map((workspace) => workspace.id));
  const localSlugs = new Map(local.workspaces.map((workspace) => [workspace.slug, workspace.id]));
  const workspaceIds = new Map<string, string>();
  const touched = new Set<string>();

  // A mapped operator already owns a personal workspace here; theirs from the
  // bundle is folded into it rather than left as a second one beside it.
  for (const [from, to] of userIds) {
    const exported = data.workspaceMembers.find((row) => row.userId === from && row.role === 'owner');
    const here = local.members.find((row) => row.userId === to && row.role === 'owner');
    if (exported && here && !localWorkspaceIds.has(exported.workspaceId)) {
      workspaceIds.set(exported.workspaceId, here.workspaceId);
    }
  }
  const workspaceIdOf = (value: string): string => workspaceIds.get(value) ?? value;

  const workspaceWrites: ExportData['workspaces'] = [];
  for (const workspace of data.workspaces) {
    if (workspaceIds.has(workspace.id) || localWorkspaceIds.has(workspace.id)) {
      workspaces.alreadyPresent += 1;
      continue;
    }
    const slugOwner = localSlugs.get(workspace.slug);
    if (slugOwner) {
      workspaces.conflicts.push(`Workspace slug “${workspace.slug}” is already taken here by another workspace.`);
      continue;
    }
    workspaces.toCreate += 1;
    workspaceWrites.push(workspace);
  }

  const members = new Section('workspaceMembers', data.workspaceMembers.length);
  const localMembers = new Set(local.members.map((row) => `${row.workspaceId}\n${row.userId}`));
  const memberWrites: ExportData['workspaceMembers'] = [];
  for (const row of data.workspaceMembers) {
    const mapped = { ...row, workspaceId: workspaceIdOf(row.workspaceId), userId: userIdOf(row.userId) };
    if (localMembers.has(`${mapped.workspaceId}\n${mapped.userId}`)) {
      members.alreadyPresent += 1;
    } else {
      members.toCreate += 1;
      memberWrites.push(mapped);
    }
  }

  // ── ledger ──────────────────────────────────────────────────────────────
  const ledger = new Section('creditLedger', data.creditLedger.length);
  const localLedgerIds = new Set(local.ledger.map((row) => row.id));
  const localLedgerKeys = new Map(local.ledger.map((row) => [row.idempotencyKey, row.id]));
  /** A ledger row that was not written because this deployment already made the same grant. */
  const ledgerIds = new Map<string, string>();
  const ledgerWrites: ExportData['creditLedger'] = [];
  let grantsAlreadyMade = 0;
  for (const entry of data.creditLedger) {
    const workspaceId = workspaceIdOf(entry.workspaceId);
    // Grant keys are spelled with the account id (`signup:<userId>`), so a
    // mapped operator's keys are re-spelled with the id the account has here —
    // which is what lets the unique index recognise a grant made twice.
    let idempotencyKey = entry.idempotencyKey;
    for (const [from, to] of userIds) {
      idempotencyKey = idempotencyKey.split(from).join(to);
    }
    if (localLedgerIds.has(entry.id)) {
      ledger.alreadyPresent += 1;
      continue;
    }
    const sameKey = localLedgerKeys.get(idempotencyKey);
    if (sameKey) {
      if (workspaceIds.has(entry.workspaceId)) {
        // The operator was credited the same grant when they claimed this
        // deployment. One grant per account is the policy; theirs stands.
        ledgerIds.set(entry.id, sameKey);
        ledger.alreadyPresent += 1;
        grantsAlreadyMade += 1;
      } else {
        ledger.conflicts.push(`Ledger entry ${entry.id} repeats an idempotency key already used here.`);
      }
      continue;
    }
    ledger.toCreate += 1;
    touched.add(workspaceId);
    ledgerWrites.push({ ...entry, workspaceId, idempotencyKey });
  }
  if (grantsAlreadyMade > 0) {
    notes.push(
      `${grantsAlreadyMade} grant(s) to an operator were already made on this deployment and are not credited twice, ` +
        'so that account’s balance here can differ from the exported one by that amount.',
    );
  }

  // ── invitations ─────────────────────────────────────────────────────────
  const codes = new Section('inviteCodes', data.inviteCodes.length);
  const localCodeIds = new Map(local.inviteCodes.map((code) => [code.id, code.code]));
  const localCodeValues = new Set(local.inviteCodes.map((code) => code.code));
  const codeWrites: ExportData['inviteCodes'] = [];
  for (const code of data.inviteCodes) {
    const here = localCodeIds.get(code.id);
    if (here !== undefined) {
      if (here === code.value) {
        codes.alreadyPresent += 1;
      } else {
        codes.conflicts.push(`Invitation code ${code.id} exists here with a different value.`);
      }
    } else if (localCodeValues.has(code.value)) {
      // Named by row id on purpose: the value is a live code and is never echoed.
      codes.conflicts.push(`The value of invitation code ${code.id} is already issued here under another id.`);
    } else {
      codes.toCreate += 1;
      codeWrites.push({ ...code, issuedByUserId: userIdOrNull(code.issuedByUserId) });
    }
  }

  const redemptions = new Section('inviteRedemptions', data.inviteRedemptions.length);
  const localRedemptionIds = new Set(local.redemptions.map((row) => row.id));
  const localRedeemers = new Set(local.redemptions.map((row) => row.userId));
  const redemptionWrites: ExportData['inviteRedemptions'] = [];
  for (const row of data.inviteRedemptions) {
    const userId = userIdOf(row.userId);
    if (localRedemptionIds.has(row.id)) {
      redemptions.alreadyPresent += 1;
    } else if (localRedeemers.has(userId)) {
      redemptions.conflicts.push(`Account ${userId} has already redeemed an invitation on this deployment.`);
    } else {
      redemptions.toCreate += 1;
      redemptionWrites.push({
        ...row,
        userId,
        workspaceId: workspaceIdOf(row.workspaceId),
        creditTransactionId: ledgerIds.get(row.creditTransactionId) ?? row.creditTransactionId,
      });
    }
  }

  // ── external endpoints and trust ────────────────────────────────────────
  const endpoints = new Section('externalEndpoints', data.externalEndpoints.length);
  const models = new Section(
    'externalModels',
    data.externalEndpoints.reduce((sum, endpoint) => sum + endpoint.models.length, 0),
  );
  const localEndpointIds = new Set(local.externalEndpoints.map((endpoint) => endpoint.id));
  const localEndpointNames = new Set(local.externalEndpoints.map((endpoint) => endpoint.name));
  const localModels = new Map(local.models.map((model) => [model.id, model.externalEndpointId]));
  const endpointWrites: ExportData['externalEndpoints'] = [];
  for (const endpoint of data.externalEndpoints) {
    if (localEndpointIds.has(endpoint.id)) {
      endpoints.alreadyPresent += 1;
      models.alreadyPresent += endpoint.models.length;
      continue;
    }
    if (localEndpointNames.has(endpoint.name)) {
      endpoints.conflicts.push(`An external endpoint named “${endpoint.name}” is already registered here.`);
      continue;
    }
    const taken = endpoint.models.filter((model) => localModels.has(model.id));
    if (taken.length > 0) {
      models.conflicts.push(
        `Model id(s) ${taken.map((model) => model.id).join(', ')} of “${endpoint.name}” are already in this catalogue.`,
      );
      continue;
    }
    endpoints.toCreate += 1;
    models.toCreate += endpoint.models.length;
    endpointWrites.push({ ...endpoint, createdByUserId: userIdOrNull(endpoint.createdByUserId) });
  }
  if (endpointWrites.length > 0) {
    notes.push(
      `${endpointWrites.length} external endpoint(s) are imported switched off and without an upstream API key — ` +
        'the export carries no secrets. Enter each key again under Administration → External endpoints, then enable it.',
    );
  }

  const measurements = new Section('trustedMeasurements', data.trustedMeasurements.length);
  const localMeasurementIds = new Set(local.trustedMeasurements.map((row) => row.id));
  const localMeasurementValues = new Set(local.trustedMeasurements.map((row) => row.measurement));
  const measurementWrites: ExportData['trustedMeasurements'] = [];
  for (const row of data.trustedMeasurements) {
    // The trust list is a set: a measurement already trusted here is simply there.
    if (localMeasurementIds.has(row.id) || localMeasurementValues.has(row.measurement)) {
      measurements.alreadyPresent += 1;
    } else {
      measurements.toCreate += 1;
      measurementWrites.push({ ...row, addedByUserId: userIdOrNull(row.addedByUserId) });
    }
  }

  return {
    refusals,
    notes,
    sections: [users, workspaces, members, ledger, codes, redemptions, endpoints, models, measurements].map((section) =>
      section.done(),
    ),
    writes: {
      users: userWrites,
      workspaces: workspaceWrites,
      workspaceMembers: memberWrites,
      creditLedger: ledgerWrites,
      inviteCodes: codeWrites,
      inviteRedemptions: redemptionWrites,
      externalEndpoints: endpointWrites,
      trustedMeasurements: measurementWrites,
    },
    touchedWorkspaceIds: [...touched],
  };
}
