import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthService, isAdminEmail } from '../auth/index.js';
import { routerConfig, serviceVersion } from '../config.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { TrustedMeasurement } from '../db/entities/trusted-measurement.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { EvidenceService } from '../evidence/index.js';
import { inviteCodeStatus } from '../invites/index.js';
import { buildBundle, type ExportBundle, type ExportData, type ExportedInviteCode } from './export-bundle.js';

const isoOf = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value ? value.toISOString() : null);
const microsOf = (value: number): string => String(value);
const microsOrNull = (value: number | null): string | null => (value === null ? null : String(value));

/**
 * Writes the deployment export (SUP-271).
 *
 * Every section names the columns it carries, one by one. That is the whole
 * mechanism behind "no secrets in the file": nothing here spreads an entity, so
 * a column added to a table tomorrow is not exported until somebody adds it to
 * this file on purpose. Left out by design, and absent from the list below:
 * chats, generations and activity, evidence snapshots, feedback answers, API
 * keys (stored hashed — their owners issue new ones), the upstream API key of an
 * external endpoint (sealed under this deployment's secrets key), sessions, and
 * every credential Better Auth holds.
 *
 * Nothing is cached or written to disk: the bundle is built for the request
 * that asked for it and is gone when the response has been sent.
 */
@Injectable()
export class DataExportService {
  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly auth: AuthService,
    private readonly evidence: EvidenceService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  async export(now: Date = new Date()): Promise<ExportBundle> {
    const data = await this.read(now);
    return buildBundle({
      data,
      exportedAt: now,
      source: {
        publicBaseUrl: this.config.server.publicBaseUrl,
        routerVersion: serviceVersion(),
        evidenceDigest: await this.ownEvidenceDigest(),
      },
    });
  }

  private async read(now: Date): Promise<ExportData> {
    const order = { createdAt: 'ASC', id: 'ASC' } as const;
    const [users, workspaces, members, ledger, codes, redemptions, endpoints, models, measurements] = await Promise.all(
      [
        this.auth.listUsers(),
        this.dataSource.getRepository(Workspace).find({ order }),
        this.dataSource.getRepository(WorkspaceMember).find({ order: { createdAt: 'ASC', workspaceId: 'ASC' } }),
        this.dataSource.getRepository(CreditTransaction).find({ order }),
        this.dataSource.getRepository(InviteCode).find({ order }),
        this.dataSource.getRepository(InviteRedemption).find({ order: { redeemedAt: 'ASC', id: 'ASC' } }),
        this.dataSource.getRepository(ExternalEndpoint).find({ order }),
        this.dataSource.getRepository(Model).find({ where: { origin: 'external' }, order: { id: 'ASC' } }),
        this.dataSource.getRepository(TrustedMeasurement).find({ order: { addedAt: 'ASC', id: 'ASC' } }),
      ],
    );

    const invitedBy = new Map(redemptions.map((row) => [row.userId, row.inviteCodeId]));
    const bootstrapEmail = this.config.auth.bootstrapEmail.toLowerCase();
    // A membership or redemption whose account is gone points at nothing; the
    // import would refuse a bundle that carried one.
    const known = new Set(users.map((user) => user.id));

    return {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        image: user.image,
        createdAt: isoOf(user.createdAt),
        role: isAdminEmail(user.email, this.config.auth.adminEmails) ? ('admin' as const) : ('user' as const),
        origin: invitedBy.has(user.id)
          ? ('invite' as const)
          : user.email.toLowerCase() === bootstrapEmail
            ? ('bootstrap' as const)
            : ('open' as const),
        invitedByCodeId: invitedBy.get(user.id) ?? null,
      })),
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        balanceMicros: microsOf(workspace.balanceMicros),
        stripeCustomerId: workspace.stripeCustomerId,
        autoTopUpEnabled: workspace.autoTopUpEnabled,
        autoTopUpThresholdMicros: microsOrNull(workspace.autoTopUpThresholdMicros),
        autoTopUpAmountMicros: microsOrNull(workspace.autoTopUpAmountMicros),
        autoTopUpLastAt: isoOrNull(workspace.autoTopUpLastAt),
        firstRequestAt: isoOrNull(workspace.firstRequestAt),
        createdAt: isoOf(workspace.createdAt),
      })),
      workspaceMembers: members
        .filter((row) => known.has(row.userId))
        .map((row) => ({
          workspaceId: row.workspaceId,
          userId: row.userId,
          role: row.role,
          createdAt: isoOf(row.createdAt),
        })),
      creditLedger: ledger.map((entry) => ({
        id: entry.id,
        workspaceId: entry.workspaceId,
        kind: entry.kind,
        amountMicros: microsOf(entry.amountMicros),
        reference: entry.reference,
        description: entry.description,
        idempotencyKey: entry.idempotencyKey,
        createdAt: isoOf(entry.createdAt),
      })),
      inviteCodes: codes.map((code) => ({
        id: code.id,
        value: code.code,
        campaign: code.campaign,
        grantMicros: microsOf(code.grantMicros),
        maxRedemptions: code.maxRedemptions,
        redemptionCount: code.redemptionCount,
        status: exportedStatus(code, now),
        expiresAt: isoOrNull(code.expiresAt),
        withdrawnAt: isoOrNull(code.disabledAt),
        note: code.note,
        issuedByUserId: code.issuedByUserId,
        createdAt: isoOf(code.createdAt),
      })),
      // The salted IP and user-agent digests stay behind: they are abuse-review
      // data keyed to this deployment's salt, and mean nothing under another.
      inviteRedemptions: redemptions
        .filter((row) => known.has(row.userId))
        .map((row) => ({
          id: row.id,
          inviteCodeId: row.inviteCodeId,
          userId: row.userId,
          workspaceId: row.workspaceId,
          creditTransactionId: row.creditTransactionId,
          redeemedAt: isoOf(row.redeemedAt),
        })),
      // The registration and the operator's trust decisions — the pinned digest
      // — and none of the verdict columns, which are re-derived from a live
      // attestation and never carried anywhere (data-model invariant 2).
      externalEndpoints: endpoints.map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        baseUrl: endpoint.baseUrl,
        listenPort: endpoint.listenPort,
        enabled: endpoint.enabled,
        pinnedEvidenceDigest: endpoint.pinnedEvidenceDigest,
        createdByUserId: endpoint.createdByUserId,
        createdAt: isoOf(endpoint.createdAt),
        models: models
          .filter((model) => model.externalEndpointId === endpoint.id)
          .map((model) => ({
            id: model.id,
            name: model.name,
            upstreamModel: model.litellmModel,
            contextLength: model.contextLength,
            capabilities: model.capabilities,
            promptPer1mMicros: microsOf(model.promptPer1mMicros),
            completionPer1mMicros: microsOf(model.completionPer1mMicros),
            enabled: model.enabled,
          })),
      })),
      trustedMeasurements: measurements.map((row) => ({
        id: row.id,
        measurement: row.measurement,
        note: row.note,
        addedByUserId: row.addedByUserId,
        addedAt: isoOf(row.addedAt),
      })),
    };
  }

  /** The digest this deployment last published for itself, when it has an endpoint of its own. */
  private async ownEvidenceDigest(): Promise<string | null> {
    const endpoint = await this.evidence.ownEndpoint();
    if (!endpoint) {
      return null;
    }
    return (await this.evidence.latestFor(endpoint.id))?.evidenceDigest ?? null;
  }
}

function exportedStatus(code: InviteCode, now: Date): ExportedInviteCode['status'] {
  const status = inviteCodeStatus(code, now);
  return status === 'active' ? 'unredeemed' : status;
}
