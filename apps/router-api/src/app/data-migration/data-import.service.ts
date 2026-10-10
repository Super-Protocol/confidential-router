import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, type EntityTarget, In, type ObjectLiteral } from 'typeorm';
import { AuthService } from '../auth/index.js';
import { routerConfig } from '../config.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { TrustedMeasurement } from '../db/entities/trusted-measurement.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { EXTERNAL_MODEL_TEE, ExternalCatalogService, SidecarConfigWriterService } from '../external-endpoints/index.js';
import {
  decodeBundle,
  type ExportBundle,
  type ExportCounts,
  type ExportData,
  type ExportSource,
} from './export-bundle.js';
import { type ImportPlan, type LocalState, planImport, planIsClean, type SectionPlan } from './import-plan.js';

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
}

/** SQLite caps a statement's bound parameters; this keeps the widest table well inside it. */
const INSERT_CHUNK = 50;

const dateOf = (value: string): Date => new Date(value);
const dateOrNull = (value: string | null): Date | null => (value === null ? null : new Date(value));
const numberOf = (value: string): number => Number(value);
const numberOrNull = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * Loads a deployment export into a fresh deployment (SUP-271).
 *
 * `plan` is the dry run and `apply` is the import; both start from the same
 * `planImport`, and `apply` writes nothing unless the plan it just computed is
 * clean. The accounts go in first, through Better Auth — which owns that table
 * and has its own connection — and everything else follows in one transaction.
 * The two cannot share one, so the order is what makes a failure between them
 * harmless: an account with no workspace yet is exactly what a retry expects to
 * find, and every write is skipped when its row is already there.
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
  async apply(file: Buffer): Promise<ImportReport> {
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
    await this.dataSource.transaction((manager) => this.write(manager, plan));

    const report = reportOf(bundle, plan, true);
    if (plan.writes.externalEndpoints.length > 0 || plan.writes.trustedMeasurements.length > 0) {
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

  private async planFor(bundle: ExportBundle): Promise<ImportPlan> {
    return planImport(bundle, await this.localState(), {
      operatorEmails: [this.config.auth.bootstrapEmail, ...this.config.auth.adminEmails],
    });
  }

  private async localState(): Promise<LocalState> {
    const repository = <T extends ObjectLiteral>(entity: EntityTarget<T>) => this.dataSource.getRepository(entity);
    const [users, workspaces, members, ledger, inviteCodes, redemptions, externalEndpoints, models, measurements] =
      await Promise.all([
        this.auth.listUsers(),
        repository(Workspace).find({ select: { id: true, slug: true } }),
        repository(WorkspaceMember).find({ select: { workspaceId: true, userId: true, role: true } }),
        repository(CreditTransaction).find({ select: { id: true, idempotencyKey: true } }),
        repository(InviteCode).find({ select: { id: true, code: true } }),
        repository(InviteRedemption).find({ select: { id: true, userId: true } }),
        repository(ExternalEndpoint).find({ select: { id: true, name: true } }),
        repository(Model).find({ select: { id: true, externalEndpointId: true } }),
        repository(TrustedMeasurement).find({ select: { id: true, measurement: true } }),
      ]);
    return {
      users,
      workspaces,
      members,
      ledger,
      inviteCodes,
      redemptions,
      externalEndpoints,
      models,
      trustedMeasurements: measurements,
    };
  }

  private async write(manager: EntityManager, plan: ImportPlan): Promise<void> {
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

    await insert(
      manager,
      ExternalEndpoint,
      writes.externalEndpoints.map((endpoint) => endpointRow(endpoint, now)),
    );
    await insert(
      manager,
      Model,
      writes.externalEndpoints.flatMap((endpoint) =>
        endpoint.models.map((model) => ({
          id: model.id,
          name: model.name,
          litellmModel: model.upstreamModel,
          origin: 'external' as const,
          endpointId: null,
          externalEndpointId: endpoint.id,
          contextLength: model.contextLength,
          capabilities: model.capabilities,
          promptPer1mMicros: numberOf(model.promptPer1mMicros),
          completionPer1mMicros: numberOf(model.completionPer1mMicros),
          tee: EXTERNAL_MODEL_TEE,
          enabled: model.enabled,
          updatedAt: now,
        })),
      ),
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
  }

  /**
   * Sets each touched workspace's cached balance to the sum of its ledger.
   *
   * An absolute write, where `LedgerService` only ever writes relatively — and
   * safe here for the reason it would not be there: this runs inside the import's
   * own transaction against workspaces that have had no traffic yet, and the
   * sum is the definition of the column.
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
  };
}
