import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, type EntityTarget, In, type ObjectLiteral } from 'typeorm';
import { AuthService, type SessionUser } from '../auth/index.js';
import { routerConfig } from '../config.js';
import { ApiKey } from '../db/entities/api-key.entity.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { DataImport } from '../db/entities/data-import.entity.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { TrustedMeasurement } from '../db/entities/trusted-measurement.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { ExternalCatalogService, SidecarConfigWriterService } from '../external-endpoints/index.js';
import {
  decodeBundle,
  type ExportBundle,
  type ExportCounts,
  type ExportData,
  type ExportSource,
} from './export-bundle.js';
import {
  type ImportPlan,
  type LocalState,
  type PriorImport,
  planImport,
  planIsClean,
  type SectionPlan,
} from './import-plan.js';

/** A `Date` as the bundle carries instants, so the plan compares like with like. */
const isoOrNull = (value: Date | null): string | null => (value === null ? null : value.toISOString());
/** A micro-USD column as the bundle carries amounts. */
const microsOf = (value: number): string => String(value);
const microsOrNull = (value: number | null): string | null => (value === null ? null : String(value));

/** What the console shows for a dry run, and again for the import that followed it. */
export interface ImportReport {
  /** True when the rows were written; false for a dry run and for a refusal. */
  applied: boolean;
  /** Whether this deployment can take the bundle. A dry run with `ok` is the go-ahead. */
  ok: boolean;
  schemaVersion: number;
  exportedAt: string;
  source: ExportSource;
  contentSha256: string;
  counts: ExportCounts;
  totalBalanceMicros: string;
  refusals: string[];
  sections: SectionPlan[];
  notes: string[];
  /**
   * The export this deployment had already taken when this file was read, if any
   * (SUP-481) — what makes a second import of the same dataset legal, and the
   * line the console shows above the plan.
   */
  lastImport: PriorImport | null;
}

/** SQLite caps a statement's bound parameters; this keeps the widest table well inside it. */
const INSERT_CHUNK = 50;

const dateOf = (value: string): Date => new Date(value);
const dateOrNull = (value: string | null): Date | null => (value === null ? null : new Date(value));
const numberOf = (value: string): number => Number(value);
const numberOrNull = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * Loads a deployment export into a deployment that holds nobody else's data
 * (SUP-271, SUP-481).
 *
 * `plan` is the dry run and `apply` is the import; both start from the same
 * `planImport`, and `apply` writes nothing unless the plan it just computed is
 * clean. The accounts go in first, through Better Auth — which owns that table
 * and has its own connection — and everything else follows in one transaction.
 * The two cannot share one, so the order is what makes a failure between them
 * harmless: an account with no workspace yet is exactly what a retry expects to
 * find, and every write is skipped when its row is already there.
 *
 * An applied import leaves a `data_imports` row naming the file it took. That
 * row is what lets the *next* import of the same source run on a deployment
 * somebody has signed up to since — the catch-up a cutover ends with — and it is
 * written in the same transaction as the rows, so a deployment never remembers an
 * import that did not happen.
 */
@Injectable()
export class DataImportService {
  private readonly logger = new Logger(DataImportService.name);

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly auth: AuthService,
    private readonly sidecar: SidecarConfigWriterService,
    private readonly catalog: ExternalCatalogService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  /** The dry run: what importing `file` would do, with nothing written. */
  async plan(file: Buffer): Promise<ImportReport> {
    const bundle = decodeBundle(file);
    return reportOf(bundle, await this.planFor(bundle), false);
  }

  /**
   * The import. Answers the same report as the dry run, with `applied` saying
   * whether it went in; a bundle that cannot be taken changes nothing.
   */
  async apply(file: Buffer, by: SessionUser): Promise<ImportReport> {
    const bundle = decodeBundle(file);
    const plan = await this.planFor(bundle);
    if (!planIsClean(plan)) {
      return reportOf(bundle, plan, false);
    }

    await this.auth.createImportedUsers(
      plan.writes.users.map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        image: user.image,
        createdAt: dateOf(user.createdAt),
      })),
    );
    await this.dataSource.transaction((manager) => this.write(manager, plan, this.recordOf(bundle, by)));

    const report = reportOf(bundle, plan, true);
    if (touchesEgress(plan)) {
      // The trust list is rendered into the egress sidecar's config; the
      // endpoints themselves arrive switched off and are therefore absent from it.
      try {
        await this.sidecar.render();
        await this.catalog.refresh();
      } catch (error) {
        // The rows are committed, so this is not a failed import: the render is
        // a full rewrite from the database and the next trust edit or boot
        // repeats it. Say so, rather than answer an error for data that is in.
        this.logger.error(
          `Imported trust list could not be rendered: ${error instanceof Error ? error.message : error}`,
        );
        report.notes.push(
          'The imported trust list is saved, but the egress configuration could not be re-rendered just now. ' +
            'It is rendered again on the next change under Administration → External endpoints, and at the next restart.',
        );
      }
    }
    return report;
  }

  /** The `data_imports` row for an import that is about to be written. */
  private recordOf(bundle: ExportBundle, by: SessionUser): DataImport {
    return {
      id: randomUUID(),
      sourcePublicBaseUrl: bundle.source.publicBaseUrl,
      sourceRouterVersion: bundle.source.routerVersion,
      bundleExportedAt: new Date(bundle.exportedAt),
      contentSha256: bundle.integrity.contentSha256,
      importedByUserId: by.id,
      importedAt: new Date(),
    };
  }

  private async planFor(bundle: ExportBundle): Promise<ImportPlan> {
    return planImport(bundle, await this.localState(), {
      operatorEmails: [this.config.auth.bootstrapEmail, ...this.config.auth.adminEmails],
    });
  }

  private async localState(): Promise<LocalState> {
    const repository = <T extends ObjectLiteral>(entity: EntityTarget<T>) => this.dataSource.getRepository(entity);
    const [
      users,
      workspaces,
      members,
      ledger,
      inviteCodes,
      redemptions,
      apiKeys,
      externalEndpoints,
      models,
      measurements,
      priorImports,
    ] = await Promise.all([
      this.auth.listUsers(),
      // Every column named: what a row is matched by, plus — for the sections a
      // second import brings up to date — the columns it may move (SUP-481).
      // Named rather than read whole on purpose, the way the export names its
      // own: it keeps `external_endpoints.apiKeyCiphertext` out of this process
      // entirely, and makes a new column a decision somebody takes here.
      repository(Workspace).find({
        select: {
          id: true,
          slug: true,
          balanceMicros: true,
          name: true,
          stripeCustomerId: true,
          autoTopUpEnabled: true,
          autoTopUpThresholdMicros: true,
          autoTopUpAmountMicros: true,
          autoTopUpLastAt: true,
          firstRequestAt: true,
        },
      }),
      repository(WorkspaceMember).find({ select: { workspaceId: true, userId: true, role: true } }),
      repository(CreditTransaction).find({ select: { id: true, idempotencyKey: true } }),
      repository(InviteCode).find({
        select: {
          id: true,
          code: true,
          campaign: true,
          grantMicros: true,
          maxRedemptions: true,
          redemptionCount: true,
          expiresAt: true,
          disabledAt: true,
          note: true,
        },
      }),
      repository(InviteRedemption).find({ select: { id: true, userId: true } }),
      repository(ApiKey).find({
        select: {
          id: true,
          keyHash: true,
          name: true,
          modelScope: true,
          spendLimitMicros: true,
          spentTotalMicros: true,
          requestsPerMinute: true,
          tokensPerMinute: true,
          expiresAt: true,
          lastUsedAt: true,
          revokedAt: true,
        },
      }),
      repository(ExternalEndpoint).find({
        select: { id: true, name: true, baseUrl: true, pinnedEvidenceDigest: true },
      }),
      repository(Model).find({
        select: {
          id: true,
          externalEndpointId: true,
          name: true,
          litellmModel: true,
          contextLength: true,
          capabilities: true,
          promptPer1mMicros: true,
          completionPer1mMicros: true,
          enabled: true,
        },
      }),
      repository(TrustedMeasurement).find({ select: { id: true, measurement: true } }),
      repository(DataImport).find({ order: { importedAt: 'DESC' } }),
    ]);
    return {
      users,
      workspaces: workspaces.map((row) => ({
        id: row.id,
        slug: row.slug,
        balanceMicros: microsOf(row.balanceMicros),
        name: row.name,
        stripeCustomerId: row.stripeCustomerId,
        autoTopUpEnabled: row.autoTopUpEnabled,
        autoTopUpThresholdMicros: microsOrNull(row.autoTopUpThresholdMicros),
        autoTopUpAmountMicros: microsOrNull(row.autoTopUpAmountMicros),
        autoTopUpLastAt: isoOrNull(row.autoTopUpLastAt),
        firstRequestAt: isoOrNull(row.firstRequestAt),
      })),
      members,
      ledger,
      inviteCodes: inviteCodes.map((row) => ({
        id: row.id,
        code: row.code,
        campaign: row.campaign,
        grantMicros: microsOf(row.grantMicros),
        maxRedemptions: row.maxRedemptions,
        redemptionCount: row.redemptionCount,
        expiresAt: isoOrNull(row.expiresAt),
        // `disabledAt` on the row, `withdrawnAt` in the bundle: one state, two
        // spellings, and the bundle's is the one the plan speaks.
        withdrawnAt: isoOrNull(row.disabledAt),
        note: row.note,
      })),
      redemptions,
      apiKeys: apiKeys.map((row) => ({
        id: row.id,
        keyHash: row.keyHash,
        name: row.name,
        modelScope: row.modelScope,
        spendLimitMicros: microsOrNull(row.spendLimitMicros),
        spentTotalMicros: microsOf(row.spentTotalMicros),
        requestsPerMinute: row.requestsPerMinute,
        tokensPerMinute: row.tokensPerMinute,
        expiresAt: isoOrNull(row.expiresAt),
        lastUsedAt: isoOrNull(row.lastUsedAt),
        revokedAt: isoOrNull(row.revokedAt),
      })),
      externalEndpoints: externalEndpoints.map((row) => ({
        id: row.id,
        name: row.name,
        baseUrl: row.baseUrl,
        pinnedEvidenceDigest: row.pinnedEvidenceDigest,
      })),
      models: models.map((row) => ({
        id: row.id,
        externalEndpointId: row.externalEndpointId,
        name: row.name,
        upstreamModel: row.litellmModel,
        contextLength: row.contextLength,
        capabilities: row.capabilities,
        promptPer1mMicros: microsOf(row.promptPer1mMicros),
        completionPer1mMicros: microsOf(row.completionPer1mMicros),
        enabled: row.enabled,
      })),
      trustedMeasurements: measurements,
      priorImports: priorImports.map((row) => ({
        sourcePublicBaseUrl: row.sourcePublicBaseUrl,
        bundleExportedAt: row.bundleExportedAt.toISOString(),
        importedAt: row.importedAt.toISOString(),
      })),
    };
  }

  private async write(manager: EntityManager, plan: ImportPlan, record: DataImport): Promise<void> {
    const { writes } = plan;
    const now = new Date();

    await insert(
      manager,
      Workspace,
      writes.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        // Zero, then summed from the ledger below — the one way a balance is
        // ever arrived at (data-model invariant 3).
        balanceMicros: 0,
        stripeCustomerId: workspace.stripeCustomerId,
        autoTopUpEnabled: workspace.autoTopUpEnabled,
        autoTopUpThresholdMicros: numberOrNull(workspace.autoTopUpThresholdMicros),
        autoTopUpAmountMicros: numberOrNull(workspace.autoTopUpAmountMicros),
        autoTopUpLastAt: dateOrNull(workspace.autoTopUpLastAt),
        firstRequestAt: dateOrNull(workspace.firstRequestAt),
        createdAt: dateOf(workspace.createdAt),
      })),
    );
    await insert(
      manager,
      WorkspaceMember,
      writes.workspaceMembers.map((row) => ({
        workspaceId: row.workspaceId,
        userId: row.userId,
        role: row.role,
        createdAt: dateOf(row.createdAt),
      })),
    );
    await insert(
      manager,
      CreditTransaction,
      writes.creditLedger.map((entry) => ({
        id: entry.id,
        workspaceId: entry.workspaceId,
        kind: entry.kind,
        amountMicros: numberOf(entry.amountMicros),
        reference: entry.reference,
        description: entry.description,
        idempotencyKey: entry.idempotencyKey,
        createdAt: dateOf(entry.createdAt),
      })),
    );
    await this.resumBalances(manager, plan.touchedWorkspaceIds);

    await insert(
      manager,
      InviteCode,
      writes.inviteCodes.map((code) => ({
        id: code.id,
        code: code.value,
        grantMicros: numberOf(code.grantMicros),
        campaign: code.campaign,
        maxRedemptions: code.maxRedemptions,
        redemptionCount: code.redemptionCount,
        expiresAt: dateOrNull(code.expiresAt),
        disabledAt: dateOrNull(code.withdrawnAt),
        note: code.note,
        issuedByUserId: code.issuedByUserId,
        createdAt: dateOf(code.createdAt),
      })),
    );
    await insert(
      manager,
      InviteRedemption,
      writes.inviteRedemptions.map((row) => ({
        id: row.id,
        inviteCodeId: row.inviteCodeId,
        userId: row.userId,
        workspaceId: row.workspaceId,
        creditTransactionId: row.creditTransactionId,
        ipHash: null,
        userAgentHash: null,
        redeemedAt: dateOf(row.redeemedAt),
      })),
    );

    // After the workspaces they belong to, and with the hash exactly as exported:
    // that column is what `ApiKeyService.authenticate` looks a presented key up
    // by, so writing it unchanged is the whole of "the key still works" (SUP-445).
    await insert(
      manager,
      ApiKey,
      writes.apiKeys.map((key) => ({
        id: key.id,
        workspaceId: key.workspaceId,
        name: key.name,
        keyHash: key.keyHash,
        prefix: key.prefix,
        purpose: key.purpose,
        modelScope: key.modelScope,
        spendLimitMicros: numberOrNull(key.spendLimitMicros),
        spentTotalMicros: numberOf(key.spentTotalMicros),
        requestsPerMinute: key.requestsPerMinute,
        tokensPerMinute: key.tokensPerMinute,
        expiresAt: dateOrNull(key.expiresAt),
        lastUsedAt: dateOrNull(key.lastUsedAt),
        revokedAt: dateOrNull(key.revokedAt),
        createdByUserId: key.createdByUserId,
        createdAt: dateOf(key.createdAt),
      })),
    );

    await insert(
      manager,
      ExternalEndpoint,
      writes.externalEndpoints.map((endpoint) => endpointRow(endpoint, now)),
    );
    // From `modelWrites`, not from the endpoints' own lists: that one list holds
    // both a new endpoint's models and any model a later export added to an
    // endpoint already here (SUP-481).
    await insert(
      manager,
      Model,
      plan.modelWrites.map((model) => ({
        id: model.id,
        name: model.name,
        litellmModel: model.upstreamModel,
        origin: 'external' as const,
        endpointId: null,
        externalEndpointId: model.externalEndpointId,
        contextLength: model.contextLength,
        capabilities: model.capabilities,
        promptPer1mMicros: numberOf(model.promptPer1mMicros),
        completionPer1mMicros: numberOf(model.completionPer1mMicros),
        enabled: model.enabled,
        updatedAt: now,
      })),
    );
    await insert(
      manager,
      TrustedMeasurement,
      writes.trustedMeasurements.map((row) => ({
        id: row.id,
        measurement: row.measurement,
        note: row.note,
        addedByUserId: row.addedByUserId,
        addedAt: dateOf(row.addedAt),
      })),
    );

    await this.refresh(manager, plan, now);

    // Last, and in this transaction: this deployment now remembers which dataset
    // it holds, which is what admits the next import of the same source (SUP-481).
    await insert(manager, DataImport, [record]);
  }

  /**
   * Brings the rows that are already here up to the export's values (SUP-481).
   *
   * The third outcome beside create and skip, and the one that makes a *later*
   * export of the same deployment mean anything: without it a code spent on the
   * old deployment arrived with its seat unspent and a revoked key arrived live.
   * `ImportRefreshes` is where the column list and the resolution rules live —
   * this method only writes what the plan has already decided, row by row, so
   * the dry run's count is the number of rows that change.
   */
  private async refresh(manager: EntityManager, plan: ImportPlan, now: Date): Promise<void> {
    const { refreshes } = plan;

    for (const { id, changes } of refreshes.workspaces) {
      await manager.update(
        Workspace,
        { id },
        {
          name: changes.name,
          stripeCustomerId: changes.stripeCustomerId,
          autoTopUpEnabled: changes.autoTopUpEnabled,
          autoTopUpThresholdMicros: numberOrNull(changes.autoTopUpThresholdMicros),
          autoTopUpAmountMicros: numberOrNull(changes.autoTopUpAmountMicros),
          autoTopUpLastAt: dateOrNull(changes.autoTopUpLastAt),
          firstRequestAt: dateOrNull(changes.firstRequestAt),
        },
      );
    }
    for (const row of refreshes.workspaceMembers) {
      await manager.update(WorkspaceMember, { workspaceId: row.workspaceId, userId: row.userId }, { role: row.role });
    }
    for (const { id, changes } of refreshes.inviteCodes) {
      await manager.update(
        InviteCode,
        { id },
        {
          campaign: changes.campaign,
          grantMicros: numberOf(changes.grantMicros),
          maxRedemptions: changes.maxRedemptions,
          redemptionCount: changes.redemptionCount,
          expiresAt: dateOrNull(changes.expiresAt),
          disabledAt: dateOrNull(changes.withdrawnAt),
          note: changes.note,
        },
      );
    }
    for (const { id, changes } of refreshes.apiKeys) {
      await manager.update(
        ApiKey,
        { id },
        {
          name: changes.name,
          modelScope: changes.modelScope,
          spendLimitMicros: numberOrNull(changes.spendLimitMicros),
          spentTotalMicros: numberOf(changes.spentTotalMicros),
          requestsPerMinute: changes.requestsPerMinute,
          tokensPerMinute: changes.tokensPerMinute,
          expiresAt: dateOrNull(changes.expiresAt),
          lastUsedAt: dateOrNull(changes.lastUsedAt),
          revokedAt: dateOrNull(changes.revokedAt),
        },
      );
    }
    for (const { id, changes } of refreshes.externalEndpoints) {
      // `hostname` is derived from `baseUrl` wherever it is written — it is what
      // the evidence bundle is fetched from and bound to.
      await manager.update(
        ExternalEndpoint,
        { id },
        {
          baseUrl: changes.baseUrl,
          hostname: new URL(changes.baseUrl).hostname,
          pinnedEvidenceDigest: changes.pinnedEvidenceDigest,
          updatedAt: now,
        },
      );
    }
    for (const { id, changes } of refreshes.externalModels) {
      await manager.update(
        Model,
        { id },
        {
          name: changes.name,
          litellmModel: changes.upstreamModel,
          contextLength: changes.contextLength,
          capabilities: changes.capabilities,
          promptPer1mMicros: numberOf(changes.promptPer1mMicros),
          completionPer1mMicros: numberOf(changes.completionPer1mMicros),
          enabled: changes.enabled,
          updatedAt: now,
        },
      );
    }
  }

  /**
   * Sets each touched workspace's cached balance to the sum of its ledger.
   *
   * An absolute write, where `LedgerService` only ever writes relatively — and
   * safe here for the reason it would not be there: it runs inside the import's
   * own transaction, over the whole of each workspace's ledger, and the sum is
   * the definition of the column. On a second import (SUP-481) that ledger
   * includes the rows this deployment wrote itself, so the balance it arrives at
   * is the imported rows *and* the local ones — which is why the sum is taken
   * from the table rather than from the bundle's own `balanceMicros`.
   */
  private async resumBalances(manager: EntityManager, workspaceIds: readonly string[]): Promise<void> {
    for (let start = 0; start < workspaceIds.length; start += INSERT_CHUNK) {
      const ids = workspaceIds.slice(start, start + INSERT_CHUNK);
      const sums = await manager
        .getRepository(CreditTransaction)
        .createQueryBuilder('entry')
        .select('entry.workspaceId', 'workspaceId')
        .addSelect('SUM(entry.amountMicros)', 'total')
        .where({ workspaceId: In(ids) })
        .groupBy('entry.workspaceId')
        .getRawMany<{ workspaceId: string; total: string | number }>();
      for (const { workspaceId, total } of sums) {
        await manager.update(Workspace, { id: workspaceId }, { balanceMicros: Number(total) });
      }
    }
  }
}

/**
 * An imported upstream arrives **switched off and with no key**.
 *
 * Its API key was sealed under the old deployment's secrets key and bound to
 * that row, and the export carries no secret of any kind — so there is nothing
 * to proxy with until an operator enters the key again. Off is rendered as
 * absence from the sidecar config, so nothing tries to open the empty envelope;
 * rotating the key and enabling the endpoint brings it back as `pending`, to be
 * attested before it serves, like any other.
 */
function endpointRow(endpoint: ExportData['externalEndpoints'][number], now: Date): Partial<ExternalEndpoint> {
  return {
    id: endpoint.id,
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    hostname: new URL(endpoint.baseUrl).hostname,
    listenPort: endpoint.listenPort,
    enabled: false,
    status: 'disabled',
    lastCheckedAt: null,
    lastStage: null,
    lastReason: null,
    measurementSeen: null,
    measurementSource: null,
    measurementInRegistry: null,
    evidenceDigestSeen: null,
    pinnedEvidenceDigest: endpoint.pinnedEvidenceDigest,
    pinnedCertFingerprint: null,
    observedCertFingerprint: null,
    apiKeyCiphertext: '',
    apiKeyPrefix: '',
    createdByUserId: endpoint.createdByUserId,
    createdAt: dateOf(endpoint.createdAt),
    updatedAt: now,
  };
}

async function insert<T extends ObjectLiteral>(
  manager: EntityManager,
  entity: EntityTarget<T>,
  rows: readonly Partial<T>[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    // `insert`, not `save`: these rows are known to be absent, and `save` would
    // read each one back first and cascade through relations nobody set.
    await manager.getRepository(entity).insert(rows.slice(start, start + INSERT_CHUNK) as never);
  }
}

/**
 * Whether anything the egress sidecar's config is rendered from has moved.
 *
 * The trust list and the endpoints are rendered into it, so a refreshed
 * `baseUrl` or pinned digest has to reach it exactly as a created endpoint does
 * (SUP-481) — and a model only through the catalogue, which is refreshed from
 * the database either way.
 */
function touchesEgress(plan: ImportPlan): boolean {
  return (
    plan.writes.externalEndpoints.length > 0 ||
    plan.writes.trustedMeasurements.length > 0 ||
    plan.modelWrites.length > 0 ||
    plan.refreshes.externalEndpoints.length > 0 ||
    plan.refreshes.externalModels.length > 0
  );
}

function reportOf(bundle: ExportBundle, plan: ImportPlan, applied: boolean): ImportReport {
  return {
    applied,
    ok: planIsClean(plan),
    schemaVersion: bundle.schemaVersion,
    exportedAt: bundle.exportedAt,
    source: bundle.source,
    contentSha256: bundle.integrity.contentSha256,
    counts: bundle.counts,
    totalBalanceMicros: bundle.totalBalanceMicros,
    refusals: plan.refusals,
    sections: plan.sections,
    notes: plan.notes,
    lastImport: plan.lastImport,
  };
}
