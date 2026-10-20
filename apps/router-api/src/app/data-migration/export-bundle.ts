import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import * as z from 'zod';
import { GENERATION_LEDGER_KEY_PREFIX } from '../billing/ledger.keys.js';

/**
 * The deployment export: one versioned JSON document, gzipped (SUP-271).
 *
 * It is what carries a small production dataset across a redeploy — accounts,
 * workspaces and their credit ledger, invitation codes with their redemptions,
 * and the external-endpoint trust configuration — and it is deliberately *not* a
 * database dump: chats, generations, sessions, API keys and every credential are
 * left behind, so the file holds no secret at all. What it does hold is personal
 * data and live invitation codes, which is why only an operator can ask for one
 * and nothing keeps a copy.
 *
 * Because the generation log stays behind, the ledger cannot cross the boundary
 * as it stands: a per-request `usage` debit names the generation it charged for,
 * and on the other side that row does not exist. {@link carryUsageForward} is
 * what reconciles the two — one carried-forward debit per workspace per month,
 * for exactly the same money (SUP-446).
 *
 * Ids are the rows' own, so every reference survives as written; instants are
 * ISO-8601 UTC; money is integer micro-USD as a decimal string, the ledger's
 * native unit, because a float dollar amount cannot round-trip a balance.
 */

export const EXPORT_FORMAT = 'router-export';

/**
 * Gates import: a version this build does not know is refused. An additive
 * field does not bump it — the importer ignores what it does not read — and a
 * change to the meaning of an existing field does.
 */
export const EXPORT_SCHEMA_VERSION = 1;

/** The upload limit, and the limit on what a bundle may inflate to. */
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

/**
 * No key anywhere in a bundle may look like a credential.
 *
 * The export selects its columns by name, so this cannot fire on a bundle this
 * build wrote — it is the tripwire for the day somebody adds a column to a
 * section without reading the paragraph above, and the reason an import refuses
 * a hand-edited file that tries to carry one in. `idempotencyKey` is the ledger's
 * retry key, not a secret, and is the one spelling let through.
 */
export const CREDENTIAL_KEY_PATTERN = /pass(word|phrase)|hash|token|secret|ciphertext|api_?key|credential|session/i;

/**
 * The id and idempotency key of the `usage` entry a workspace's per-request
 * debits of one month are carried over as: `carried-usage:<yyyy-mm>:<workspaceId>`.
 * See {@link carryUsageForward}.
 */
export const CARRIED_USAGE_LEDGER_KEY_PREFIX = 'carried-usage:';

/**
 * What a row id may be, in the bundle and in `credit_transactions.id` alike.
 *
 * Named because {@link carryUsageForward} is the one place that *composes* an id
 * rather than copying one, and a composed id is the one that can outgrow the
 * column. 64 leaves 42 characters for a workspace id after the prefix and the
 * month — a UUID is 36 — and `buildBundle` says so in words rather than letting
 * it surface as a zod error from the import of a file the export just wrote.
 */
export const MAX_ID_LENGTH = 64;

const iso = z.iso.datetime({ offset: true });
const micros = z.string().regex(/^-?\d+$/, 'must be an integer amount of micro-USD');
const id = z.string().min(1).max(MAX_ID_LENGTH);

const UserSchema = z.object({
  id,
  email: z.string().min(3).max(320),
  name: z.string().max(255),
  emailVerified: z.boolean(),
  image: z.string().max(2048).nullable(),
  createdAt: iso,
  /** Informational: operators are named by the *importing* deployment's `auth.adminEmails`. */
  role: z.enum(['admin', 'user']),
  /** Informational: how the account came to exist. The redemptions are the record. */
  origin: z.enum(['invite', 'bootstrap', 'open']),
  invitedByCodeId: id.nullable(),
});

const WorkspaceSchema = z.object({
  id,
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(64),
  balanceMicros: micros,
  stripeCustomerId: z.string().max(255).nullable(),
  autoTopUpEnabled: z.boolean(),
  autoTopUpThresholdMicros: micros.nullable(),
  autoTopUpAmountMicros: micros.nullable(),
  autoTopUpLastAt: iso.nullable(),
  firstRequestAt: iso.nullable(),
  createdAt: iso,
});

const WorkspaceMemberSchema = z.object({
  workspaceId: id,
  userId: id,
  role: z.enum(['owner', 'member']),
  createdAt: iso,
});

const CreditEntrySchema = z.object({
  id,
  workspaceId: id,
  kind: z.enum(['purchase', 'usage', 'refund', 'adjustment', 'auto_topup', 'grant']),
  amountMicros: micros,
  reference: z.string().max(128).nullable(),
  description: z.string().max(512).nullable(),
  idempotencyKey: z.string().min(1).max(128),
  createdAt: iso,
});

const InviteCodeSchema = z.object({
  id,
  /** The normalised code. The one sensitive field in the file: an unredeemed one is live. */
  value: z.string().min(1).max(32),
  campaign: z.string().max(64),
  grantMicros: micros,
  maxRedemptions: z.number().int().min(1),
  redemptionCount: z.number().int().min(0),
  status: z.enum(['unredeemed', 'redeemed', 'withdrawn', 'expired']),
  expiresAt: iso.nullable(),
  withdrawnAt: iso.nullable(),
  note: z.string().max(512).nullable(),
  issuedByUserId: id.nullable(),
  createdAt: iso,
});

const InviteRedemptionSchema = z.object({
  id,
  inviteCodeId: id,
  userId: id,
  workspaceId: id,
  creditTransactionId: id,
  redeemedAt: iso,
});

const ExternalModelSchema = z.object({
  id: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  upstreamModel: z.string().min(1).max(255),
  contextLength: z.number().int().min(0),
  capabilities: z.array(z.enum(['chat', 'completions', 'embeddings'])),
  promptPer1mMicros: micros,
  completionPer1mMicros: micros,
  enabled: z.boolean(),
});

const ExternalEndpointSchema = z.object({
  id,
  name: z.string().min(1).max(64),
  baseUrl: z.url().max(2048),
  listenPort: z.number().int().min(1).max(65535),
  /** What the operator had it set to. It is imported switched off — see `DataImportService`. */
  enabled: z.boolean(),
  pinnedEvidenceDigest: z.string().max(128).nullable(),
  createdByUserId: id.nullable(),
  createdAt: iso,
  models: z.array(ExternalModelSchema),
});

const TrustedMeasurementSchema = z.object({
  id,
  measurement: z.string().min(1).max(64),
  note: z.string().max(255).nullable(),
  addedByUserId: id.nullable(),
  addedAt: iso,
});

const DataSchema = z.object({
  users: z.array(UserSchema),
  workspaces: z.array(WorkspaceSchema),
  workspaceMembers: z.array(WorkspaceMemberSchema),
  creditLedger: z.array(CreditEntrySchema),
  inviteCodes: z.array(InviteCodeSchema),
  inviteRedemptions: z.array(InviteRedemptionSchema),
  externalEndpoints: z.array(ExternalEndpointSchema),
  trustedMeasurements: z.array(TrustedMeasurementSchema),
});

const CountsSchema = z.object({
  users: z.number().int(),
  workspaces: z.number().int(),
  workspaceMembers: z.number().int(),
  creditEntries: z.number().int(),
  inviteCampaigns: z.number().int(),
  inviteCodes: z.number().int(),
  inviteCodesUnredeemed: z.number().int(),
  inviteRedemptions: z.number().int(),
  externalEndpoints: z.number().int(),
  externalModels: z.number().int(),
  trustedMeasurements: z.number().int(),
});

const SourceSchema = z.object({
  /** `server.publicBaseUrl` of the deployment that wrote the file. */
  publicBaseUrl: z.string(),
  routerVersion: z.string(),
  /** The digest of the evidence that deployment last published for itself, if it had any. */
  evidenceDigest: z.string().nullable(),
});

export const ExportBundleSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  schemaVersion: z.number().int(),
  exportedAt: iso,
  source: SourceSchema,
  counts: CountsSchema,
  /** Sum of every workspace balance, so the dry run can show one number to compare. */
  totalBalanceMicros: micros,
  data: DataSchema,
  integrity: z.object({
    /** Lower-case hex SHA-256 of {@link canonicalJson} of `data`. */
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

export type ExportBundle = z.infer<typeof ExportBundleSchema>;
export type ExportData = ExportBundle['data'];
export type ExportCounts = ExportBundle['counts'];
export type ExportSource = ExportBundle['source'];
export type ExportedUser = ExportData['users'][number];
export type ExportedCreditEntry = ExportData['creditLedger'][number];
export type ExportedWorkspace = ExportData['workspaces'][number];
export type ExportedInviteCode = ExportData['inviteCodes'][number];
export type ExportedExternalEndpoint = ExportData['externalEndpoints'][number];

/** Why a file is not a bundle this build will read. Always safe to show the operator. */
export class BundleRefusedError extends Error {
  override readonly name = 'BundleRefusedError';
}

/**
 * JSON with object keys sorted at every level, so one dataset has one byte
 * string and therefore one hash, whatever order a driver returned columns in.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentSha256(data: unknown): string {
  return createHash('sha256').update(canonicalJson(data), 'utf8').digest('hex');
}

export function countsOf(data: ExportData): ExportCounts {
  return {
    users: data.users.length,
    workspaces: data.workspaces.length,
    workspaceMembers: data.workspaceMembers.length,
    creditEntries: data.creditLedger.length,
    inviteCampaigns: new Set(data.inviteCodes.map((code) => code.campaign)).size,
    inviteCodes: data.inviteCodes.length,
    inviteCodesUnredeemed: data.inviteCodes.filter((code) => code.status === 'unredeemed').length,
    inviteRedemptions: data.inviteRedemptions.length,
    externalEndpoints: data.externalEndpoints.length,
    externalModels: data.externalEndpoints.reduce((sum, endpoint) => sum + endpoint.models.length, 0),
    trustedMeasurements: data.trustedMeasurements.length,
  };
}

export function totalBalanceMicros(data: ExportData): string {
  return String(data.workspaces.reduce((sum, workspace) => sum + BigInt(workspace.balanceMicros), 0n));
}

/** Whether an entry is the usage debit of one metered request (`LedgerService.debitGeneration`). */
export function isPerGenerationUsage(entry: ExportedCreditEntry): boolean {
  return entry.kind === 'usage' && entry.idempotencyKey.startsWith(GENERATION_LEDGER_KEY_PREFIX);
}

/** Whether an entry is itself the result of an earlier {@link carryUsageForward}. */
export function isCarriedUsage(entry: ExportedCreditEntry): boolean {
  return entry.kind === 'usage' && entry.idempotencyKey.startsWith(CARRIED_USAGE_LEDGER_KEY_PREFIX);
}

/**
 * Replaces a workspace's per-request usage debits with one carried-forward debit
 * per calendar month, for exactly the same total (SUP-446).
 *
 * A `usage` entry is written per metered request and names that request:
 * `reference` is the generation id and `idempotencyKey` is `generation:<id>`.
 * `generations` is not in the bundle and cannot be: `Generation.modelId` is
 * `NOT NULL` and names a row in `models`, which this deployment projects from
 * its own `router.yaml` and the bundle does not carry at all — only an external
 * endpoint's models travel. An imported generation would need the destination's
 * config to already declare every model id the source ever served, or a broken
 * foreign key; `endpointId` and `evidenceSnapshotId` are in the same position,
 * and nulling `endpointId` would break `generationEndpointIsExclusive` and leave
 * a row no screen can reach. So the debit cannot be carried as written either:
 * on the far side it is a charge pointing at a request the console has no row
 * for, which is how a workspace comes to be billed $0.24 for 87 requests while
 * its log shows 22 (SUP-446). Collapsing also *shrinks* the file, which carried
 * one ledger row per metered request before this.
 *
 * Collapsing keeps the money exact — the sum is unchanged, so invariant 3 and
 * the bundle's own balance check hold either way — and makes the Credits screen
 * agree with the generation log on the one deployment the reader is looking at:
 * every request it lists is one this deployment served, and what was spent
 * before the migration is a row per month that says so.
 *
 * **Why a month and not one row.** One row per workspace would date a year of
 * spend at its last charge, and "what did I spend in September" would have no
 * answer after a migration. A month is the coarsest bucket a bill is ever read
 * in, it is bounded at twelve rows a year however busy the workspace, and it
 * leaves the fold below unchanged — a bucket is keyed on its own month, so an
 * earlier migration's entry belongs to exactly one.
 *
 * Applied on both sides: the export writes no per-request debit, and the import
 * collapses any it is given, so a bundle written by an older build is repaired
 * rather than refused.
 *
 * At most one carried entry per workspace per month, ever: a deployment that was
 * itself imported into already has one for each month it inherited, and a month
 * that gets new traffic here folds the inherited entry into the new one rather
 * than emitting a second row under the same id. A month with nothing new is
 * passed through exactly as it stands — rewriting it would re-date that spend to
 * a deployment which never served a request of it.
 *
 * `sourceLabel` names the deployment the spend happened on, as a bare host —
 * never a URL, which the Credits screen would render as a receipt link
 * (`amounts.ts`).
 */
export function carryUsageForward(entries: readonly ExportedCreditEntry[], sourceLabel: string): ExportedCreditEntry[] {
  const bucketOf = (entry: ExportedCreditEntry): string => `${entry.workspaceId}\n${monthOf(entry.createdAt)}`;

  // Only a bucket with something new to collapse is rewritten at all.
  const collapsing = new Set(entries.filter(isPerGenerationUsage).map(bucketOf));

  const kept: ExportedCreditEntry[] = [];
  const collapsed = new Map<string, { totalMicros: bigint; requests: number; absorbed: number; lastAt: string }>();

  for (const entry of entries) {
    const bucket = bucketOf(entry);
    const mine = collapsing.has(bucket) && (isPerGenerationUsage(entry) || isCarriedUsage(entry));
    if (!mine) {
      kept.push(entry);
      continue;
    }
    const request = isPerGenerationUsage(entry) ? 1 : 0;
    const seen = collapsed.get(bucket);
    if (!seen) {
      collapsed.set(bucket, {
        totalMicros: BigInt(entry.amountMicros),
        requests: request,
        absorbed: 1 - request,
        lastAt: entry.createdAt,
      });
      continue;
    }
    seen.totalMicros += BigInt(entry.amountMicros);
    seen.requests += request;
    seen.absorbed += 1 - request;
    // By instant, not by string: an ISO-8601 timestamp may carry an offset.
    if (Date.parse(entry.createdAt) > Date.parse(seen.lastAt)) {
      seen.lastAt = entry.createdAt;
    }
  }

  // Sorted by bucket, so one dataset exports to one byte string whatever order
  // the rows came back in — the same reason `canonicalJson` exists.
  const carried = [...collapsed.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucket, { totalMicros, requests, absorbed, lastAt }]) => {
      const [workspaceId = '', month = ''] = bucket.split('\n');
      const key = carriedUsageKey(workspaceId, month);
      return {
        id: key,
        workspaceId,
        kind: 'usage' as const,
        amountMicros: String(totalMicros),
        // Deliberately null: the generations these debits named stayed behind,
        // and a reference to a row that does not exist is the defect, not the
        // record.
        reference: null,
        description:
          `Metered usage carried over from ${sourceLabel}: ${plural(requests, 'request')} served in ${month}` +
          (absorbed > 0 ? ', plus usage carried from an earlier migration' : '') +
          '. The per-request log stayed on the deployment that served it.',
        idempotencyKey: key,
        createdAt: lastAt,
      };
    });

  return [...kept, ...carried];
}

/** The id and idempotency key of one carried bucket. See {@link MAX_ID_LENGTH}. */
export function carriedUsageKey(workspaceId: string, month: string): string {
  return `${CARRIED_USAGE_LEDGER_KEY_PREFIX}${month}:${workspaceId}`;
}

/**
 * The UTC calendar month an instant falls in, `yyyy-mm`.
 *
 * Through `Date` rather than by slicing the string: an ISO-8601 timestamp may
 * carry an offset, and `2026-10-01T00:30:00+02:00` is September in UTC — which
 * is the month every other total on these screens would put it in.
 */
function monthOf(instant: string): string {
  return new Date(instant).toISOString().slice(0, 7);
}

/** `1 request` / `42 requests` — a count on a money screen that reads as English. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The deployment a bundle's spend happened on, for {@link carryUsageForward}'s
 * description. The host alone — see that function on why not the URL.
 */
export function sourceLabelOf(publicBaseUrl: string): string {
  try {
    return new URL(publicBaseUrl).host;
  } catch {
    return publicBaseUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  }
}

/** Every key path in `value` that {@link CREDENTIAL_KEY_PATTERN} matches. */
export function credentialShapedKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    // One row stands for its section: the rows of a section share their keys.
    return value.length > 0 ? credentialShapedKeys(value[0], `${path}[]`) : [];
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const here = path ? `${path}.${key}` : key;
    const own = key !== 'idempotencyKey' && CREDENTIAL_KEY_PATTERN.test(key) ? [here] : [];
    return [...own, ...credentialShapedKeys(entry, here)];
  });
}

/** Assembles the document around a dataset: counts, total and hash are derived, never passed in. */
export function buildBundle(input: { data: ExportData; source: ExportSource; exportedAt: Date }): ExportBundle {
  const leaked = credentialShapedKeys(input.data);
  if (leaked.length > 0) {
    throw new Error(`The export would carry credential-shaped fields (${leaked.join(', ')}); refusing to write it.`);
  }
  // The same kind of tripwire, for the same kind of mistake: a per-request debit
  // in an assembled bundle means somebody added a ledger section without
  // {@link carryUsageForward}, and the file would charge for requests the
  // importing deployment has no log of (SUP-446).
  const dangling = input.data.creditLedger.filter(isPerGenerationUsage).length;
  if (dangling > 0) {
    throw new Error(
      `The export would carry ${dangling} usage debit(s) naming a generation it does not carry; refusing to write it.`,
    );
  }
  // `carryUsageForward` is the one place an id is composed rather than copied,
  // so it is the one that can outgrow `MAX_ID_LENGTH`. Said here, where the
  // workspace id that caused it can be named, rather than left to surface as
  // `malformed at data.creditLedger.N.id` on importing a file this build wrote.
  const overlong = input.data.creditLedger.filter((entry) => entry.id.length > MAX_ID_LENGTH);
  if (overlong.length > 0) {
    throw new Error(
      `The export would carry ${overlong.length} ledger entr(y/ies) whose id exceeds ${MAX_ID_LENGTH} characters ` +
        `(workspace ${overlong[0]?.workspaceId}); refusing to write it.`,
    );
  }
  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: input.exportedAt.toISOString(),
    source: input.source,
    counts: countsOf(input.data),
    totalBalanceMicros: totalBalanceMicros(input.data),
    data: input.data,
    integrity: { contentSha256: contentSha256(input.data) },
  };
}

export function encodeBundle(bundle: ExportBundle): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'));
}

/**
 * Reads an uploaded file back into a bundle, or says why it is not one.
 *
 * Everything the file claims about itself is re-derived and compared: the hash
 * over `data`, the counts, the total. A file whose manifest disagrees with its
 * contents was truncated or edited, and neither is something to import from.
 */
export function decodeBundle(file: Buffer): ExportBundle {
  if (file.length === 0) {
    throw new BundleRefusedError('The upload is empty.');
  }
  let text: string;
  try {
    text = gunzipSync(file, { maxOutputLength: MAX_INFLATED_BYTES }).toString('utf8');
  } catch {
    throw new BundleRefusedError('The file is not a gzip archive, so it is not a router export.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BundleRefusedError('The file does not contain JSON, so it is not a router export.');
  }

  const header = z.object({ format: z.literal(EXPORT_FORMAT), schemaVersion: z.number().int() }).safeParse(raw);
  if (!header.success) {
    throw new BundleRefusedError('The file is not a router export.');
  }
  if (header.data.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new BundleRefusedError(
      `The export is schema version ${header.data.schemaVersion}; this deployment reads version ` +
        `${EXPORT_SCHEMA_VERSION}. Import it into a build that knows that version.`,
    );
  }

  const leaked = credentialShapedKeys((raw as { data?: unknown }).data);
  if (leaked.length > 0) {
    throw new BundleRefusedError(
      `The export carries credential-shaped fields (${leaked.join(', ')}). A router export never does, so this file is refused.`,
    );
  }

  const parsed = ExportBundleSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BundleRefusedError(
      `The export is malformed at ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}.`,
    );
  }
  const bundle = parsed.data;

  // Over the file's own `data`, not the parsed one: parsing drops fields this
  // build does not read, and an additive field must not read as damage.
  if (contentSha256((raw as { data: unknown }).data) !== bundle.integrity.contentSha256) {
    throw new BundleRefusedError(
      'The export’s contents do not match its own SHA-256, so it was altered or damaged after it was written.',
    );
  }
  if (canonicalJson(countsOf(bundle.data)) !== canonicalJson(bundle.counts)) {
    throw new BundleRefusedError('The export’s manifest counts do not match its contents.');
  }
  if (totalBalanceMicros(bundle.data) !== bundle.totalBalanceMicros) {
    throw new BundleRefusedError('The export’s total balance does not match its workspaces.');
  }
  return bundle;
}
