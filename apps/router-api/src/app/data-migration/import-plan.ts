import { canonicalJson, type ExportBundle, type ExportData } from './export-bundle.js';

/**
 * What an import would do, worked out without writing anything (SUP-271).
 *
 * The dry run and the real import are the same computation: `planImport` reads
 * a bundle and a picture of what this deployment already holds, and answers
 * with the rows to create, the rows already here and everything that stands in
 * the way. The import then writes exactly `plan.writes`, so the screen that
 * said "42 accounts" cannot be followed by an import of 41.
 *
 * Four things decide the shape of it:
 *
 *  - **Only a deployment nobody else's data is in is imported into.** An account
 *    that is here and not in the bundle is a refusal, unless it is an operator's
 *    own — somebody had to sign in to press the button.
 *  - **A second import of the same dataset is the rebuild's normal shape**, not
 *    an accident (SUP-481). A cutover is export, import, verify, hand the
 *    hostname over; the verification is a real sign-up here, and the old
 *    deployment serves until the handover — so the last thing the runbook does
 *    is import again, to catch up the rows that were served in between. Once
 *    this deployment is known to hold this source's data, an account the bundle
 *    does not carry is no longer a stranger but that verification: it is counted
 *    as `localOnly`, kept exactly as it is, and the import still creates only
 *    what is missing.
 *  - **A retry is not a collision.** A row already present under the same id is
 *    counted and skipped, so an import interrupted between its two halves (the
 *    accounts are written through Better Auth's connection, everything else in
 *    one transaction) is finished by running it again.
 *  - **A row of the bundle that is already here is brought up to date**, which is
 *    the third outcome beside create and skip (SUP-481). A *later* export of the
 *    same deployment carries the same row with its mutable columns moved on, and
 *    skipping it froze them at the first export: an invitation code spent on the
 *    old deployment arrived with its seat unspent and could be redeemed a second
 *    time, a key revoked there arrived live. Which columns travel, and which of
 *    them a counter rather than an assignment, is {@link ImportRefreshes}.
 *  - **The operator who claimed the new deployment is the same person as the
 *    operator in the bundle.** The bootstrap account gets a new id here, so the
 *    bundle's account of the same address is *mapped* onto it — its workspace,
 *    ledger and attribution land on the account that is signed in — rather than
 *    refused as a duplicate address.
 */

/**
 * A deployment export this deployment has already taken (SUP-481). See `DataImport`.
 */
export interface PriorImport {
  /** `source.publicBaseUrl` of the bundle that was imported. */
  sourcePublicBaseUrl: string;
  /** That bundle's `exportedAt`, ISO-8601. */
  bundleExportedAt: string;
  importedAt: string;
}

/**
 * What a second import brings up to date on a row that is already here, and what
 * it deliberately leaves alone (SUP-481).
 *
 * The bundle is the source of truth for the rows it owns, so a row here under an
 * exported row's own id is that row, one export later. Three rules shape the list
 * below, and the reason each section is in it or out of it is beside it:
 *
 *  - **Never through a mapping.** An operator's account and personal workspace
 *    are *mapped* onto the ids they have here — a different row, with this
 *    deployment's own name. Only a row matched under its own id is refreshed.
 *  - **Never a column another row could already hold.** A workspace slug, an
 *    endpoint name, a sidecar listen port: moving one of those could collide
 *    with a local-only row and refuse the catch-up import at the worst possible
 *    moment, for a rename nothing behaves differently about.
 *  - **Never backwards.** A counter this deployment advanced itself, and a state
 *    that only ever goes one way, are resolved rather than assigned: `max` for a
 *    spend counter and a last-used instant, the earlier of the two for a
 *    revocation or a withdrawal, the number of seats actually spent on both
 *    deployments for a redemption count.
 *
 * Out, with the reason: **users** — Better Auth owns the table and the mutable
 * columns are the account's own profile; a changed address is a conflict, not a
 * refresh. **creditLedger** and **inviteRedemptions** — append-only records of
 * things that happened (data-model invariant 3). **trustedMeasurements** — the
 * list is a set and its only mutable column is an operator's note; note that an
 * import never *removes* a trust entry, so one withdrawn on the source has to be
 * withdrawn here by hand.
 */
export interface ImportRefreshes {
  workspaces: RowRefresh<WorkspaceRefresh>[];
  workspaceMembers: MemberRefresh[];
  inviteCodes: RowRefresh<InviteCodeRefresh>[];
  apiKeys: RowRefresh<ApiKeyRefresh>[];
  externalEndpoints: RowRefresh<ExternalEndpointRefresh>[];
  externalModels: RowRefresh<ExternalModelRefresh>[];
}

/** One row to bring up to date, named by the id it has here. */
export interface RowRefresh<Changes> {
  id: string;
  changes: Changes;
}

/** Settings and the first-request claim. `balanceMicros` is never copied — it is re-summed. */
export interface WorkspaceRefresh {
  name: string;
  stripeCustomerId: string | null;
  autoTopUpEnabled: boolean;
  autoTopUpThresholdMicros: string | null;
  autoTopUpAmountMicros: string | null;
  autoTopUpLastAt: string | null;
  firstRequestAt: string | null;
}

/** A membership has no id of its own, so its own pair names it. */
export interface MemberRefresh {
  workspaceId: string;
  userId: string;
  role: 'owner' | 'member';
}

export interface InviteCodeRefresh {
  campaign: string;
  grantMicros: string;
  maxRedemptions: number;
  /** Seats spent on both deployments — never the exported count on its own. */
  redemptionCount: number;
  expiresAt: string | null;
  /** Withdrawn on either deployment stays withdrawn. */
  withdrawnAt: string | null;
  note: string | null;
}

export interface ApiKeyRefresh {
  name: string;
  modelScope: string[] | null;
  spendLimitMicros: string | null;
  /** Never backwards: the verification may have spent against this very key. */
  spentTotalMicros: string;
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** Revoked on either deployment stays revoked. */
  revokedAt: string | null;
}

/**
 * Where the upstream is and which deployment of it the operator approved.
 *
 * Not `enabled`, `status`, a verdict column or the sealed key: an imported
 * endpoint arrives switched off and keyless, and if an operator has since
 * entered the key and enabled it here, that is this deployment's own state.
 * `pinnedEvidenceDigest` travels *with* `baseUrl`, which is exactly the shape
 * SUP-435 asks of an edit that re-points an endpoint: an approval of its own.
 */
export interface ExternalEndpointRefresh {
  baseUrl: string;
  pinnedEvidenceDigest: string | null;
}

export interface ExternalModelRefresh {
  name: string;
  upstreamModel: string;
  contextLength: number;
  capabilities: ExportedModel['capabilities'];
  promptPer1mMicros: string;
  completionPer1mMicros: string;
  enabled: boolean;
}

type ExportedModel = ExportData['externalEndpoints'][number]['models'][number];

/** An external model to write, under the endpoint it belongs to. */
export interface ExternalModelWrite extends ExportedModel {
  externalEndpointId: string;
}

/**
 * A local row as the plan compares it: the identity columns it is matched by, and
 * the refreshable ones in the bundle's own units — ISO-8601 instants, micro-USD
 * as decimal strings — so the comparison is like for like.
 */
export interface LocalWorkspace extends WorkspaceRefresh {
  id: string;
  slug: string;
  balanceMicros: string;
}
export interface LocalInviteCode extends InviteCodeRefresh {
  id: string;
  code: string;
}
export interface LocalApiKey extends ApiKeyRefresh {
  id: string;
  keyHash: string;
}
export interface LocalExternalEndpoint extends ExternalEndpointRefresh {
  id: string;
  name: string;
}
export interface LocalModel extends ExternalModelRefresh {
  id: string;
  externalEndpointId: string | null;
}

/** What is already in the database the import would write into. */
export interface LocalState {
  users: readonly { id: string; email: string }[];
  workspaces: readonly LocalWorkspace[];
  members: readonly { workspaceId: string; userId: string; role: string }[];
  /** Ledger row id by idempotency key — the two things a ledger row can collide on. */
  ledger: readonly { id: string; idempotencyKey: string }[];
  inviteCodes: readonly LocalInviteCode[];
  redemptions: readonly { id: string; userId: string }[];
  /** Key id and the hash it authenticates by — the two things an API key can collide on. */
  apiKeys: readonly LocalApiKey[];
  externalEndpoints: readonly LocalExternalEndpoint[];
  models: readonly LocalModel[];
  trustedMeasurements: readonly { id: string; measurement: string }[];
  /** Imports this deployment has applied, **newest first**. Empty on one that has taken none. */
  priorImports: readonly PriorImport[];
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
  | 'apiKeys'
  | 'externalEndpoints'
  | 'externalModels'
  | 'trustedMeasurements';

export interface SectionPlan {
  section: SectionName;
  inBundle: number;
  toCreate: number;
  /** Already here under the same identity — a retry, or the operator's own account. */
  alreadyPresent: number;
  /**
   * Of the {@link alreadyPresent}, how many the export has moved on from and the
   * import brings up to date (SUP-481). A subset of that count, not a third
   * total: `inBundle` is still `toCreate` plus `alreadyPresent`.
   */
  toRefresh: number;
  /**
   * Here and not in the bundle, and therefore left exactly as they are: the rows
   * this deployment grew since it was imported, which a second import keeps
   * rather than refuses (SUP-481).
   */
  localOnly: number;
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
  /**
   * External models to write, under the endpoint they belong to — a new
   * endpoint's whole list, and any model a later export added to an endpoint
   * already here (SUP-481).
   */
  modelWrites: ExternalModelWrite[];
  /** Rows already here that the export has moved on from. */
  refreshes: ImportRefreshes;
  /** Workspaces whose cached balance has to be re-summed from the ledger afterwards. */
  touchedWorkspaceIds: string[];
  /** The last export this deployment had taken before this one, if any. */
  lastImport: PriorImport | null;
}

export function planIsClean(plan: ImportPlan): boolean {
  return plan.refusals.length === 0 && plan.sections.every((section) => section.conflicts.length === 0);
}

const lower = (value: string): string => value.trim().toLowerCase();

/**
 * The earlier of two instants, either of which may be absent.
 *
 * Absent means "has not happened", so it loses to an instant: a revocation or a
 * withdrawal on either deployment is one that happened, and a refresh never
 * un-does it.
 */
const earliest = (here: string | null, there: string | null): string | null => {
  if (here === null) return there;
  if (there === null) return here;
  return Date.parse(here) <= Date.parse(there) ? here : there;
};

/** The later of two instants, for a column that only ever moves forward. */
const latest = (here: string | null, there: string | null): string | null => {
  if (here === null) return there;
  if (there === null) return here;
  return Date.parse(here) >= Date.parse(there) ? here : there;
};

/** The larger of two micro-USD amounts, in the decimal string they travel as. */
const larger = (here: string, there: string): string => (BigInt(here) >= BigInt(there) ? here : there);

/**
 * `wanted` when it says something the row here does not already say, else
 * nothing.
 *
 * Compared through {@link canonicalJson} over the keys of `wanted` alone, so the
 * test is one of value: a row whose columns already agree with the export is
 * `alreadyPresent` and nothing else, and the plan's refresh count is the number
 * of rows an operator would see change.
 */
function movedOn<Changes extends object>(here: object, wanted: Changes): Changes | undefined {
  const mine = Object.fromEntries(Object.keys(wanted).map((key) => [key, (here as Record<string, unknown>)[key]]));
  return canonicalJson(mine) === canonicalJson(wanted) ? undefined : wanted;
}

class Section {
  toCreate = 0;
  alreadyPresent = 0;
  toRefresh = 0;
  localOnly = 0;
  readonly conflicts: string[] = [];
  /**
   * The local rows the bundle accounts for, by their id here — matched under
   * their own id, mapped onto an operator's, or collided with. Whatever is left
   * over is {@link localOnly}, so the two are worked out from one walk.
   */
  private readonly accounted = new Set<string>();

  constructor(
    readonly section: SectionName,
    readonly inBundle: number,
  ) {}

  /** Records that a local row is accounted for, and answers it back. */
  accountFor<T extends string | undefined>(localId: T): T {
    if (localId !== undefined) {
      this.accounted.add(localId);
    }
    return localId;
  }

  /** Counts whatever `rows` the walk did not account for. */
  keeps(rows: readonly { id: string }[]): void {
    this.localOnly = rows.filter((row) => !this.accounted.has(row.id)).length;
  }

  done(): SectionPlan {
    const { section, inBundle, toCreate, alreadyPresent, toRefresh, localOnly, conflicts } = this;
    return { section, inBundle, toCreate, alreadyPresent, toRefresh, localOnly, conflicts };
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

  missing(
    'API key(s) belong to a workspace the export does not carry.',
    data.apiKeys.filter((row) => !workspaces.has(row.workspaceId)).length,
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
  duplicated(
    'API key',
    data.apiKeys.map((key) => key.id),
  );
  // Named by id, never by hash: two rows with one hash would import as a unique
  // index violation halfway through the transaction.
  duplicated(
    'API key hash',
    data.apiKeys.map((key) => key.keyHash),
  );
  return problems;
}

/**
 * Whether this deployment already holds rows of the dataset in `data`.
 *
 * Ids travel in the bundle, so a row here under an exported row's own id can
 * only have arrived by an import of this same dataset — identifiers that long do
 * not collide by accident. It is the evidence a hostname change cannot take away
 * (a parked deployment can be renamed between the two exports of one cutover),
 * and the only evidence left on a deployment imported by a build older than
 * `data_imports`.
 *
 * Every section is read, not just `users`: an operator's own account, workspace
 * and sign-up grant are *mapped* onto the ids they have here instead of being
 * written under the exported ones, so a deployment whose only account is the
 * operator leaves its trace somewhere else — in the invitation codes, the keys
 * or the trust list.
 *
 * It is a little wider than "the same source", and knowingly: two deployments
 * imported from one export share its ids, so this says yes to a bundle from a
 * *sibling* rebuild as well as from the source itself. Every id generator on the
 * other side of it mints a fresh UUID — including the SUP-272 codes CSV, which
 * does not carry the ids it reads — so an overlap can still only come from an
 * import of this dataset, and nothing is admitted that did not. Merging two
 * siblings that have diverged is guesswork of the kind the original refusal
 * existed to prevent, and `docs/router.md` says so beside the refusals that
 * remain; it is a thing an operator can do deliberately, not one they can
 * stumble into.
 */
function holdsRowsOf(data: ExportData, local: LocalState): boolean {
  const overlaps = (exported: readonly { id: string }[], present: readonly { id: string }[]): boolean => {
    const here = new Set(present.map((row) => row.id));
    return exported.some((row) => here.has(row.id));
  };
  return (
    overlaps(data.users, local.users) ||
    overlaps(data.workspaces, local.workspaces) ||
    overlaps(data.creditLedger, local.ledger) ||
    overlaps(data.inviteCodes, local.inviteCodes) ||
    overlaps(data.inviteRedemptions, local.redemptions) ||
    overlaps(data.apiKeys, local.apiKeys) ||
    overlaps(data.externalEndpoints, local.externalEndpoints) ||
    overlaps(data.trustedMeasurements, local.trustedMeasurements)
  );
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

  // Whether this deployment has taken this dataset before — a recorded import
  // from the same source, or rows of it already here. Either is enough, and the
  // recorded source URL is not required to match, because a cutover can rename
  // the source deployment between its two exports (SUP-481).
  const lastImport = local.priorImports[0] ?? null;
  const fromSameSource = local.priorImports.filter(
    (prior) => prior.sourcePublicBaseUrl === bundle.source.publicBaseUrl,
  );
  const takenBefore = fromSameSource.length > 0 || holdsRowsOf(data, local);

  const strangers = local.users.filter((user) => {
    const sameId = bundleUserById.get(user.id);
    if (sameId) {
      return false; // judged below, as a row of the bundle
    }
    return !operators.has(lower(user.email));
  });
  if (strangers.length > 0 && !takenBefore) {
    refusals.push(
      `This deployment is not fresh: ${strangers.length} account(s) exist here that are neither in the export nor ` +
        'an operator’s own, and nothing here came from this export’s deployment. An export is only imported into a ' +
        'deployment nobody else has signed up to yet — or again, into the one it was already imported into.',
    );
  } else if (strangers.length > 0) {
    notes.push(
      `${strangers.length} account(s) here are not in the export: they signed up on this deployment after it was ` +
        `imported from ${bundle.source.publicBaseUrl}. They are kept exactly as they are — with their workspace, ` +
        'balance and keys — and this import only adds what the file holds and this deployment does not. The ' +
        '“here only” column counts what is kept, section by section.',
    );
  }
  // The newest *export* taken from this source, not the newest import of one:
  // two files imported out of order would otherwise hide the staler of them.
  const taken = fromSameSource.reduce<PriorImport | null>(
    (newest, prior) =>
      newest && Date.parse(newest.bundleExportedAt) >= Date.parse(prior.bundleExportedAt) ? newest : prior,
    null,
  );
  if (taken && Date.parse(taken.bundleExportedAt) >= Date.parse(bundle.exportedAt)) {
    notes.push(
      `This file was exported at ${bundle.exportedAt}, no later than the export of the same deployment already ` +
        `imported here (${taken.bundleExportedAt}), so it carries nothing that happened since. Export again if you ` +
        'are catching up the rows served since.',
    );
  }

  /** Bundle account id → the id it has here, for an operator who re-claimed the deployment. */
  const userIds = new Map<string, string>();
  const userWrites: ExportData['users'] = [];
  for (const user of data.users) {
    const sameId = localUserById.get(user.id);
    const sameEmail = localUserByEmail.get(lower(user.email));
    if (sameId) {
      users.accountFor(sameId.id);
      if (lower(sameId.email) === lower(user.email)) {
        users.alreadyPresent += 1;
      } else {
        users.conflicts.push(`Account ${user.id} exists here under a different address.`);
      }
    } else if (sameEmail && operators.has(lower(user.email))) {
      // An operator who re-claimed this deployment: the same person, under the
      // id Better Auth gave their account here.
      userIds.set(user.id, users.accountFor(sameEmail.id));
      users.alreadyPresent += 1;
    } else if (sameEmail) {
      // One address, two accounts, and nothing that says they are one person —
      // merging them would join two identities' workspaces and ledgers. Named by
      // id, never by address, like every other message in this plan.
      users.conflicts.push(`The address of account ${user.id} is held here by another account, ${sameEmail.id}.`);
      users.accountFor(sameEmail.id);
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
  users.keeps(local.users);
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
      workspaceIds.set(exported.workspaceId, workspaces.accountFor(here.workspaceId));
    }
  }
  const workspaceIdOf = (value: string): string => workspaceIds.get(value) ?? value;

  const workspaceWrites: ExportData['workspaces'] = [];
  const localWorkspaceById = new Map(local.workspaces.map((workspace) => [workspace.id, workspace]));
  const workspaceRefreshes: RowRefresh<WorkspaceRefresh>[] = [];
  for (const workspace of data.workspaces) {
    if (workspaceIds.has(workspace.id)) {
      // Folded into the workspace the operator already owns here. A different
      // row with this deployment's own name: mapped, never refreshed.
      workspaces.accountFor(workspaceIdOf(workspace.id));
      workspaces.alreadyPresent += 1;
      continue;
    }
    const mine = localWorkspaceById.get(workspace.id);
    if (mine) {
      workspaces.accountFor(workspace.id);
      workspaces.alreadyPresent += 1;
      const changes = movedOn(mine, {
        name: workspace.name,
        stripeCustomerId: workspace.stripeCustomerId,
        autoTopUpEnabled: workspace.autoTopUpEnabled,
        autoTopUpThresholdMicros: workspace.autoTopUpThresholdMicros,
        autoTopUpAmountMicros: workspace.autoTopUpAmountMicros,
        autoTopUpLastAt: latest(mine.autoTopUpLastAt, workspace.autoTopUpLastAt),
        // A claim already made here is not un-made: `first_request_sent` fires
        // once per workspace and this column is when it did.
        firstRequestAt: earliest(mine.firstRequestAt, workspace.firstRequestAt),
      } satisfies WorkspaceRefresh);
      if (changes) {
        workspaces.toRefresh += 1;
        workspaceRefreshes.push({ id: workspace.id, changes });
        // Re-summed afterwards like any touched workspace: a refreshed row never
        // keeps a cached balance nobody has checked against its ledger.
        touched.add(workspace.id);
      }
      continue;
    }
    const slugOwner = localSlugs.get(workspace.slug);
    if (slugOwner) {
      workspaces.accountFor(slugOwner);
      workspaces.conflicts.push(`Workspace slug “${workspace.slug}” is already taken here by another workspace.`);
      continue;
    }
    workspaces.toCreate += 1;
    workspaceWrites.push(workspace);
  }
  workspaces.keeps(local.workspaces);

  const members = new Section('workspaceMembers', data.workspaceMembers.length);
  const localMembers = new Set(local.members.map((row) => `${row.workspaceId}\n${row.userId}`));
  const memberWrites: ExportData['workspaceMembers'] = [];
  const localMemberRoles = new Map(local.members.map((row) => [`${row.workspaceId}\n${row.userId}`, row.role]));
  const memberRefreshes: MemberRefresh[] = [];
  const mappedMembers = new Set<string>();
  for (const row of data.workspaceMembers) {
    const mapped = { ...row, workspaceId: workspaceIdOf(row.workspaceId), userId: userIdOf(row.userId) };
    const key = `${mapped.workspaceId}\n${mapped.userId}`;
    mappedMembers.add(key);
    if (!localMembers.has(key)) {
      members.toCreate += 1;
      memberWrites.push(mapped);
      continue;
    }
    members.alreadyPresent += 1;
    const through = workspaceIds.has(row.workspaceId) || userIds.has(row.userId);
    if (!through && localMemberRoles.get(key) !== mapped.role) {
      // A role is authority: a member demoted on the old deployment must not
      // arrive here still owning the workspace.
      members.toRefresh += 1;
      memberRefreshes.push({ workspaceId: mapped.workspaceId, userId: mapped.userId, role: mapped.role });
    }
  }
  // A membership has no id of its own, so its own pair is what is counted.
  members.localOnly = local.members.filter((row) => !mappedMembers.has(`${row.workspaceId}\n${row.userId}`)).length;

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
      ledger.accountFor(entry.id);
      ledger.alreadyPresent += 1;
      continue;
    }
    const sameKey = ledger.accountFor(localLedgerKeys.get(idempotencyKey));
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
  ledger.keeps(local.ledger);
  if (grantsAlreadyMade > 0) {
    notes.push(
      `${grantsAlreadyMade} grant(s) to an operator were already made on this deployment and are not credited twice, ` +
        'so that account’s balance here can differ from the exported one by that amount.',
    );
  }

  // ── invitations ─────────────────────────────────────────────────────────
  // Read before the codes, because a code's counter is a function of them: the
  // seat gate is `redemptionCount` on the code row (`invites.service.ts`), not a
  // count of redemption rows, so the plan has to know which redemptions it is
  // about to write before it can say what the counter should read.
  const localRedemptionIds = new Set(local.redemptions.map((row) => row.id));
  const localRedeemers = new Map(local.redemptions.map((row) => [row.userId, row.id]));
  const newRedemptionsByCode = new Map<string, number>();
  for (const row of data.inviteRedemptions) {
    const userId = userIdOf(row.userId);
    if (!localRedemptionIds.has(row.id) && localRedeemers.get(userId) === undefined) {
      newRedemptionsByCode.set(row.inviteCodeId, (newRedemptionsByCode.get(row.inviteCodeId) ?? 0) + 1);
    }
  }

  const codes = new Section('inviteCodes', data.inviteCodes.length);
  const localCodeById = new Map(local.inviteCodes.map((code) => [code.id, code]));
  const localCodeValues = new Map(local.inviteCodes.map((code) => [code.code, code.id]));
  const codeWrites: ExportData['inviteCodes'] = [];
  const codeRefreshes: RowRefresh<InviteCodeRefresh>[] = [];
  const oversold: string[] = [];
  for (const code of data.inviteCodes) {
    const mine = localCodeById.get(code.id);
    const sameValue = localCodeValues.get(code.value);
    if (mine !== undefined) {
      codes.accountFor(code.id);
      if (mine.code !== code.value) {
        codes.conflicts.push(`Invitation code ${code.id} exists here with a different value.`);
        continue;
      }
      codes.alreadyPresent += 1;
      // Seats spent on *both* deployments, never the exported count on its own:
      // this deployment may have spent one of its own during the verification,
      // and assigning the file's number would put that seat back on sale.
      const redemptionCount = mine.redemptionCount + (newRedemptionsByCode.get(code.id) ?? 0);
      const changes = movedOn(mine, {
        campaign: code.campaign,
        grantMicros: code.grantMicros,
        maxRedemptions: code.maxRedemptions,
        redemptionCount,
        expiresAt: code.expiresAt,
        // Withdrawn on either deployment stays withdrawn.
        withdrawnAt: earliest(mine.withdrawnAt, code.withdrawnAt),
        note: code.note,
      } satisfies InviteCodeRefresh);
      if (changes) {
        codes.toRefresh += 1;
        codeRefreshes.push({ id: code.id, changes });
      }
      if (redemptionCount > code.maxRedemptions) {
        oversold.push(code.id);
      }
    } else if (sameValue !== undefined) {
      // Named by row id on purpose: the value is a live code and is never echoed.
      codes.accountFor(sameValue);
      codes.conflicts.push(`The value of invitation code ${code.id} is already issued here under another id.`);
    } else {
      codes.toCreate += 1;
      codeWrites.push({ ...code, issuedByUserId: userIdOrNull(code.issuedByUserId) });
    }
  }
  codes.keeps(local.inviteCodes);
  if (oversold.length > 0) {
    notes.push(
      `Invitation code(s) ${oversold.join(', ')} were redeemed on this deployment and on the exported one both, ` +
        'past the seats they have. Every grant already made stands — the ledger carries them — and the code will ' +
        'not redeem again here. Named by row id: an invitation code is never echoed.',
    );
  }

  const redemptions = new Section('inviteRedemptions', data.inviteRedemptions.length);
  const redemptionWrites: ExportData['inviteRedemptions'] = [];
  for (const row of data.inviteRedemptions) {
    const userId = userIdOf(row.userId);
    const alreadyRedeemed = localRedeemers.get(userId);
    if (localRedemptionIds.has(row.id)) {
      redemptions.accountFor(row.id);
      redemptions.alreadyPresent += 1;
    } else if (alreadyRedeemed !== undefined) {
      redemptions.accountFor(alreadyRedeemed);
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
  redemptions.keeps(local.redemptions);

  // ── API keys ────────────────────────────────────────────────────────────
  // The point of the section: a key the user configured somewhere keeps working
  // after the redeploy (SUP-445). It authenticates by hash, so a hash already
  // here under another id is the one thing that cannot be written as it is.
  const keys = new Section('apiKeys', data.apiKeys.length);
  const localKeyHashes = new Map(local.apiKeys.map((key) => [key.keyHash, key.id]));
  const localKeysById = new Map(local.apiKeys.map((key) => [key.id, key]));
  const keyWrites: ExportData['apiKeys'] = [];
  const keyRefreshes: RowRefresh<ApiKeyRefresh>[] = [];
  for (const key of data.apiKeys) {
    const mine = localKeysById.get(key.id);
    const sameCredential = localKeyHashes.get(key.keyHash);
    if (mine !== undefined) {
      keys.accountFor(key.id);
      if (mine.keyHash !== key.keyHash) {
        keys.conflicts.push(`API key ${key.id} exists here as a different credential.`);
        continue;
      }
      keys.alreadyPresent += 1;
      const changes = movedOn(mine, {
        name: key.name,
        modelScope: key.modelScope,
        spendLimitMicros: key.spendLimitMicros,
        // Never backwards: the verification may have spent against this very
        // key, and that spend is the only record of those generations here.
        spentTotalMicros: larger(mine.spentTotalMicros, key.spentTotalMicros),
        requestsPerMinute: key.requestsPerMinute,
        tokensPerMinute: key.tokensPerMinute,
        expiresAt: key.expiresAt,
        lastUsedAt: latest(mine.lastUsedAt, key.lastUsedAt),
        // SUP-445 carries a key so it keeps working; a key revoked on either
        // deployment has to stay dead just as firmly.
        revokedAt: earliest(mine.revokedAt, key.revokedAt),
      } satisfies ApiKeyRefresh);
      if (changes) {
        keys.toRefresh += 1;
        keyRefreshes.push({ id: key.id, changes });
      }
      continue;
    }
    if (sameCredential !== undefined) {
      keys.accountFor(sameCredential);
      keys.conflicts.push(`The credential of API key ${key.id} is already registered here under another id.`);
      continue;
    }
    keys.toCreate += 1;
    keyWrites.push({
      ...key,
      workspaceId: workspaceIdOf(key.workspaceId),
      createdByUserId: userIdOrNull(key.createdByUserId),
    });
  }
  keys.keeps(local.apiKeys);
  if (keyWrites.length > 0) {
    const live = keyWrites.filter((key) => key.revokedAt === null).length;
    notes.push(
      `${keyWrites.length} API key(s) are imported, ${live} of them still live: a key configured in a Gatekeeper, ` +
        'an IDE or a script keeps working here, and nobody has to issue a new one. A revoked key arrives revoked.',
    );
  }

  // ── external endpoints and trust ────────────────────────────────────────
  const endpoints = new Section('externalEndpoints', data.externalEndpoints.length);
  const models = new Section(
    'externalModels',
    data.externalEndpoints.reduce((sum, endpoint) => sum + endpoint.models.length, 0),
  );
  const localEndpointById = new Map(local.externalEndpoints.map((endpoint) => [endpoint.id, endpoint]));
  const localEndpointNames = new Map(local.externalEndpoints.map((endpoint) => [endpoint.name, endpoint.id]));
  const localModelById = new Map(local.models.map((model) => [model.id, model]));
  const endpointWrites: ExportData['externalEndpoints'] = [];
  const endpointRefreshes: RowRefresh<ExternalEndpointRefresh>[] = [];
  const modelWrites: ExternalModelWrite[] = [];
  const modelRefreshes: RowRefresh<ExternalModelRefresh>[] = [];

  /** Each model of an endpoint that is here: written, brought up to date, or a collision. */
  const planModelsOf = (endpoint: ExportData['externalEndpoints'][number]): void => {
    for (const model of endpoint.models) {
      const mine = localModelById.get(model.id);
      if (mine === undefined) {
        // A model the later export added to an endpoint already here. Counted
        // and written per model: a whole list skipped is how a model the file
        // carries gets reported as "already here" and never arrives.
        models.toCreate += 1;
        modelWrites.push({ ...model, externalEndpointId: endpoint.id });
        continue;
      }
      models.accountFor(model.id);
      if (mine.externalEndpointId !== endpoint.id) {
        models.conflicts.push(
          `Model id ${model.id} of “${endpoint.name}” is already in this catalogue under ` +
            `${mine.externalEndpointId === null ? 'this deployment’s own configuration' : 'another endpoint'}.`,
        );
        continue;
      }
      models.alreadyPresent += 1;
      const changes = movedOn(mine, {
        name: model.name,
        upstreamModel: model.upstreamModel,
        contextLength: model.contextLength,
        capabilities: model.capabilities,
        promptPer1mMicros: model.promptPer1mMicros,
        completionPer1mMicros: model.completionPer1mMicros,
        enabled: model.enabled,
      } satisfies ExternalModelRefresh);
      if (changes) {
        models.toRefresh += 1;
        modelRefreshes.push({ id: model.id, changes });
      }
    }
  };

  for (const endpoint of data.externalEndpoints) {
    const sameName = localEndpointNames.get(endpoint.name);
    const mine = localEndpointById.get(endpoint.id);
    if (mine !== undefined) {
      endpoints.accountFor(endpoint.id);
      endpoints.alreadyPresent += 1;
      const changes = movedOn(mine, {
        baseUrl: endpoint.baseUrl,
        pinnedEvidenceDigest: endpoint.pinnedEvidenceDigest,
      } satisfies ExternalEndpointRefresh);
      if (changes) {
        endpoints.toRefresh += 1;
        endpointRefreshes.push({ id: endpoint.id, changes });
      }
      planModelsOf(endpoint);
      continue;
    }
    if (sameName !== undefined) {
      endpoints.accountFor(sameName);
      endpoints.conflicts.push(`An external endpoint named “${endpoint.name}” is already registered here.`);
      continue;
    }
    const taken = endpoint.models.filter((model) => localModelById.has(model.id));
    if (taken.length > 0) {
      for (const model of taken) {
        models.accountFor(model.id);
      }
      models.conflicts.push(
        `Model id(s) ${taken.map((model) => model.id).join(', ')} of “${endpoint.name}” are already in this catalogue.`,
      );
      continue;
    }
    endpoints.toCreate += 1;
    models.toCreate += endpoint.models.length;
    endpointWrites.push({ ...endpoint, createdByUserId: userIdOrNull(endpoint.createdByUserId) });
    for (const model of endpoint.models) {
      modelWrites.push({ ...model, externalEndpointId: endpoint.id });
    }
  }
  endpoints.keeps(local.externalEndpoints);
  // Only the external rows: a `config` model is a projection of router.yaml,
  // reconciled at every boot, and is nobody's drift.
  models.keeps(local.models.filter((model) => model.externalEndpointId !== null));
  if (endpointWrites.length > 0) {
    notes.push(
      `${endpointWrites.length} external endpoint(s) are imported switched off and without an upstream API key — ` +
        'the export carries no secrets. Enter each key again under Administration → External endpoints, then enable it.',
    );
  }

  const measurements = new Section('trustedMeasurements', data.trustedMeasurements.length);
  const localMeasurementIds = new Set(local.trustedMeasurements.map((row) => row.id));
  const localMeasurementValues = new Map(local.trustedMeasurements.map((row) => [row.measurement, row.id]));
  const measurementWrites: ExportData['trustedMeasurements'] = [];
  for (const row of data.trustedMeasurements) {
    // The trust list is a set: a measurement already trusted here is simply there.
    const sameMeasurement = localMeasurementValues.get(row.measurement);
    if (localMeasurementIds.has(row.id) || sameMeasurement !== undefined) {
      measurements.accountFor(localMeasurementIds.has(row.id) ? row.id : sameMeasurement);
      measurements.alreadyPresent += 1;
    } else {
      measurements.toCreate += 1;
      measurementWrites.push({ ...row, addedByUserId: userIdOrNull(row.addedByUserId) });
    }
  }
  measurements.keeps(local.trustedMeasurements);
  if (takenBefore && measurements.localOnly > 0) {
    notes.push(
      `${measurements.localOnly} trusted measurement(s) here are not in the export. An import never removes a trust ` +
        'entry — only adds — so if one of them was withdrawn on the exported deployment, withdraw it here by hand ' +
        'under Administration → External endpoints.',
    );
  }

  return {
    refusals,
    notes,
    sections: [users, workspaces, members, ledger, codes, redemptions, keys, endpoints, models, measurements].map(
      (section) => section.done(),
    ),
    writes: {
      users: userWrites,
      workspaces: workspaceWrites,
      workspaceMembers: memberWrites,
      creditLedger: ledgerWrites,
      inviteCodes: codeWrites,
      inviteRedemptions: redemptionWrites,
      apiKeys: keyWrites,
      externalEndpoints: endpointWrites,
      trustedMeasurements: measurementWrites,
    },
    modelWrites,
    refreshes: {
      workspaces: workspaceRefreshes,
      workspaceMembers: memberRefreshes,
      inviteCodes: codeRefreshes,
      apiKeys: keyRefreshes,
      externalEndpoints: endpointRefreshes,
      externalModels: modelRefreshes,
    },
    touchedWorkspaceIds: [...touched],
    lastImport,
  };
}
