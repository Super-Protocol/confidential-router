import { Inject, Logger, NotFoundException, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  AdminGuard,
  CurrentUser,
  isAdminEmail,
  SessionGuard,
  type SessionUser,
  UserProfileService,
} from '../../../auth/index.js';
import { routerConfig } from '../../../config.js';
import type { ExternalEndpointEvent } from '../../../db/entities/external-endpoint-event.entity.js';
import type { Model } from '../../../db/entities/model.entity.js';
import type { TrustedMeasurement } from '../../../db/entities/trusted-measurement.entity.js';
import {
  ExternalEndpointAdminService,
  type ExternalEndpointView,
  type ExternalModelSpec,
} from '../../../external-endpoints/index.js';
import {
  AddTrustedMeasurementInputModel,
  ExternalEndpointEventModel,
  ExternalEndpointModel,
  type ExternalModelInputModel,
  ExternalModelModel,
  RegisterExternalEndpointInputModel,
  RotateExternalEndpointKeyInputModel,
  SetExternalEndpointEnabledInputModel,
  TrustedMeasurementModel,
  UpdateExternalEndpointInputModel,
  UpdateTrustedMeasurementInputModel,
} from './external-endpoints.model.js';

/** Default and ceiling for one timeline page. The table holds tens of rows per endpoint, not thousands. */
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;

/**
 * External model endpoints and the trust list that admits them (ADR-008 §7).
 *
 * Two audiences, and the split is the product decision rather than an
 * implementation detail (ruling 3 on SUP-221):
 *
 *  - **Any signed-in user reads.** The endpoint list with its status, the
 *    measurement and digest each verdict saw, and the trust list itself. An
 *    operator who could curate external capacity in secret is the configuration
 *    this product must not be able to sell as confidential — so transparency is
 *    `SessionGuard`, not `AdminGuard`.
 *  - **Only `auth.adminEmails` writes**, and `AdminGuard` is applied per method
 *    rather than per class precisely because the queries above are not admin-only.
 *    Two of the read fields — the stored key's prefix and who registered the
 *    endpoint — are the operator's own business and come back `null` to everyone
 *    else; `isAdminEmail` is the same judgement the guard makes, so a screen
 *    cannot be offered a field whose mutation would be refused.
 *
 * The anonymous surface is untouched: `models` exposes no endpoint URL, no trust
 * list and no verdict detail, because nothing here is reachable without a session.
 *
 * Every mutation writes a WARN naming the operator — the invites resolver's
 * precedent, and for the same reason: on a published cluster the container log is
 * the only audit trail there is, and admitting a cloud or dropping one is the kind
 * of action someone may later have to prove they performed.
 */
@Resolver()
export class ExternalEndpointsResolver {
  private readonly logger = new Logger(ExternalEndpointsResolver.name);

  constructor(
    private readonly admin: ExternalEndpointAdminService,
    private readonly profiles: UserProfileService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
  ) {}

  @Query(() => [ExternalEndpointModel], {
    name: 'externalEndpoints',
    description:
      'Every registered external endpoint with what this router currently says about it. Read-only for any ' +
      'signed-in user; operator fields are null for everyone else.',
  })
  @UseGuards(SessionGuard)
  async externalEndpoints(@CurrentUser() user: SessionUser): Promise<ExternalEndpointModel[]> {
    return this.present(await this.admin.list(), user);
  }

  @Query(() => ExternalEndpointModel, {
    name: 'externalEndpoint',
    nullable: true,
    description: 'One external endpoint, by id.',
  })
  @UseGuards(SessionGuard)
  async externalEndpoint(
    @CurrentUser() user: SessionUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ExternalEndpointModel | null> {
    const view = await this.admin.find(id);
    return view ? (await this.present([view], user))[0] : null;
  }

  /**
   * The verdict and status timeline, newest first.
   *
   * Visible to any signed-in user for the same reason the status is: a verdict
   * history nobody but the operator can read is a transparency claim that cannot
   * be checked. These rows are history and never trust — on boot the endpoint is
   * re-attested from nothing, whatever the last entry says (§8).
   */
  @Query(() => [ExternalEndpointEventModel], {
    name: 'externalEndpointEvents',
    description: 'One endpoint’s verdict and status timeline, newest first.',
  })
  @UseGuards(SessionGuard)
  async externalEndpointEvents(
    @Args('externalEndpointId', { type: () => ID }) externalEndpointId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: DEFAULT_EVENT_LIMIT }) limit?: number,
  ): Promise<ExternalEndpointEventModel[]> {
    const events = await this.admin.events(externalEndpointId, clampLimit(limit));
    return events.map(eventModel);
  }

  @Query(() => [TrustedMeasurementModel], {
    name: 'trustedMeasurements',
    description:
      'The measurements this deployment accepts for an external upstream. Read-only for any signed-in user: a ' +
      'trust list only the operator can see is not a trust list anyone can audit.',
  })
  @UseGuards(SessionGuard)
  async trustedMeasurements(@CurrentUser() user: SessionUser): Promise<TrustedMeasurementModel[]> {
    const rows = await this.admin.listMeasurements();
    const emails = await this.emailsOf(
      rows.map((row) => row.addedByUserId),
      user,
    );
    return rows.map((row) => measurementModel(row, emails));
  }

  @Mutation(() => ExternalEndpointModel, {
    description:
      'Registers an upstream. It serves nothing until the egress sidecar reports a verdict admitting it, so the ' +
      'row starts PENDING. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async registerExternalEndpoint(
    @CurrentUser() user: SessionUser,
    @Args('input') input: RegisterExternalEndpointInputModel,
  ): Promise<ExternalEndpointModel> {
    const view = await this.admin.register({
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      models: input.models.map(modelSpec),
      createdByUserId: user.id,
    });
    // The key is not in this line and never will be — only the prefix, which is
    // what identifies the credential without carrying it.
    this.logger.warn(
      `External endpoint "${view.endpoint.name}" registered by ${user.email} — ${view.endpoint.baseUrl}, ` +
        `${view.models.length} model(s), key ${view.endpoint.apiKeyPrefix}….`,
    );
    return this.presentOne(view, user);
  }

  @Mutation(() => ExternalEndpointModel, {
    description: 'Renames, re-points or re-prices an endpoint. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async updateExternalEndpoint(
    @CurrentUser() user: SessionUser,
    @Args('input') input: UpdateExternalEndpointInputModel,
  ): Promise<ExternalEndpointModel> {
    const view = await this.admin.update({
      id: input.id,
      name: input.name,
      baseUrl: input.baseUrl,
      models: input.models?.map(modelSpec),
    });
    this.logger.warn(
      `External endpoint "${view.endpoint.name}" updated by ${user.email} — ${view.endpoint.baseUrl}, ` +
        `${view.models.filter((model) => model.enabled).length} model(s) listed.`,
    );
    return this.presentOne(view, user);
  }

  @Mutation(() => ExternalEndpointModel, {
    description:
      'Switches an endpoint off, or back on. Off removes it from the sidecar config entirely; on returns it to ' +
      'PENDING so it re-attests before it serves. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async setExternalEndpointEnabled(
    @CurrentUser() user: SessionUser,
    @Args('input') input: SetExternalEndpointEnabledInputModel,
  ): Promise<ExternalEndpointModel> {
    const view = await this.admin.setEnabled(input.id, input.enabled);
    this.logger.warn(
      `External endpoint "${view.endpoint.name}" ${input.enabled ? 'enabled' : 'disabled'} by ${user.email}.`,
    );
    return this.presentOne(view, user);
  }

  @Mutation(() => ExternalEndpointModel, {
    description:
      'Replaces the stored upstream API key. There is no read path for the old one. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async rotateExternalEndpointKey(
    @CurrentUser() user: SessionUser,
    @Args('input') input: RotateExternalEndpointKeyInputModel,
  ): Promise<ExternalEndpointModel> {
    const view = await this.admin.rotateKey(input.id, input.apiKey);
    this.logger.warn(
      `External endpoint "${view.endpoint.name}" key rotated by ${user.email} — now ${view.endpoint.apiKeyPrefix}….`,
    );
    return this.presentOne(view, user);
  }

  @Mutation(() => TrustedMeasurementModel, {
    description:
      'Admits one more cloud. It admits a cloud, never a deployment — any TEE on it satisfies the check. ' +
      'Takes effect on the next check, not after the re-attest interval. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async addTrustedMeasurement(
    @CurrentUser() user: SessionUser,
    @Args('input') input: AddTrustedMeasurementInputModel,
  ): Promise<TrustedMeasurementModel> {
    const row = await this.admin.addMeasurement(input.measurement, input.note ?? null, user.id);
    this.logger.warn(`Trusted measurement ${row.measurement} added by ${user.email}.`);
    return measurementModel(row, new Map([[user.id, user.email]]));
  }

  @Mutation(() => TrustedMeasurementModel, {
    description:
      'Rewrites the note beside an entry. The measurement itself is immutable. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async updateTrustedMeasurement(
    @CurrentUser() user: SessionUser,
    @Args('input') input: UpdateTrustedMeasurementInputModel,
  ): Promise<TrustedMeasurementModel> {
    const row = await this.admin.updateMeasurementNote(input.id, input.note ?? null);
    this.logger.warn(`Trusted measurement ${row.measurement} annotated by ${user.email}.`);
    return measurementModel(row, await this.emailsOf([row.addedByUserId], user));
  }

  @Mutation(() => TrustedMeasurementModel, {
    description:
      'Withdraws a cloud. Live and fail-closed: every endpoint admitted only by this measurement is denied on ' +
      'the next forced check, which drops its models from /v1/models. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async removeTrustedMeasurement(
    @CurrentUser() user: SessionUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<TrustedMeasurementModel> {
    const row = await this.admin.removeMeasurement(id);
    this.logger.warn(`Trusted measurement ${row.measurement} withdrawn by ${user.email} — dependent upstreams deny.`);
    return measurementModel(row, await this.emailsOf([row.addedByUserId], user));
  }

  private async presentOne(view: ExternalEndpointView, user: SessionUser): Promise<ExternalEndpointModel> {
    const [presented] = await this.present([view], user);
    if (!presented) {
      throw new NotFoundException('External endpoint not found.');
    }
    return presented;
  }

  /**
   * Shapes the rows for the caller that asked.
   *
   * The admin check happens here rather than in a guard because this query is not
   * admin-only — the narrowing is per *field*, not per operation, and a non-admin
   * gets the whole endpoint minus the two fields that are about the operator
   * rather than about the upstream.
   */
  private async present(views: ExternalEndpointView[], user: SessionUser): Promise<ExternalEndpointModel[]> {
    const emails = await this.emailsOf(
      views.map((view) => view.endpoint.createdByUserId),
      user,
    );
    const admin = this.isAdmin(user);
    return views.map(({ endpoint, models }) => ({
      id: endpoint.id,
      name: endpoint.name,
      baseUrl: endpoint.baseUrl,
      hostname: endpoint.hostname,
      enabled: endpoint.enabled,
      status: endpoint.status,
      lastCheckedAt: endpoint.lastCheckedAt,
      lastStage: endpoint.lastStage,
      lastReason: endpoint.lastReason,
      measurementSeen: endpoint.measurementSeen,
      measurementSource: endpoint.measurementSource,
      evidenceDigestSeen: endpoint.evidenceDigestSeen,
      pinnedCertFingerprint: endpoint.pinnedCertFingerprint,
      apiKeyPrefix: admin ? endpoint.apiKeyPrefix : null,
      registeredBy: (endpoint.createdByUserId && emails.get(endpoint.createdByUserId)) || null,
      models: models.map(externalModel),
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
    }));
  }

  /**
   * Addresses for the operator fields, in one query — and only for an operator.
   *
   * A non-admin gets an empty map, so the lookup is not run at all: the account
   * that registered an upstream is not part of the transparency ruling, and
   * answering it to every signed-in user would publish the operators' addresses.
   */
  private async emailsOf(userIds: readonly (string | null)[], user: SessionUser): Promise<Map<string, string>> {
    if (!this.isAdmin(user)) {
      return new Map();
    }
    return this.profiles.emailsOf(userIds.filter((id): id is string => !!id));
  }

  private isAdmin(user: SessionUser): boolean {
    return isAdminEmail(user.email, this.config.auth.adminEmails);
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_EVENT_LIMIT, 1), MAX_EVENT_LIMIT);
}

function modelSpec(input: ExternalModelInputModel): ExternalModelSpec {
  return {
    id: input.id,
    name: input.name,
    upstreamModel: input.upstreamModel,
    contextLength: input.contextLength,
    capabilities: input.capabilities,
    promptPer1mMicros: Number(input.promptPer1mMicros),
    completionPer1mMicros: Number(input.completionPer1mMicros),
    tee: input.tee,
  };
}

function externalModel(row: Model): ExternalModelModel {
  return {
    id: row.id,
    name: row.name,
    upstreamModel: row.litellmModel,
    contextLength: row.contextLength,
    capabilities: row.capabilities,
    promptPer1mMicros: String(row.promptPer1mMicros),
    completionPer1mMicros: String(row.completionPer1mMicros),
    tee: row.tee,
    enabled: row.enabled,
  };
}

function eventModel(row: ExternalEndpointEvent): ExternalEndpointEventModel {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    stage: row.stage,
    reason: row.reason,
    measurement: row.measurement,
    evidenceDigest: row.evidenceDigest,
  };
}

function measurementModel(row: TrustedMeasurement, emails: Map<string, string>): TrustedMeasurementModel {
  return {
    id: row.id,
    measurement: row.measurement,
    note: row.note,
    addedBy: (row.addedByUserId && emails.get(row.addedByUserId)) || null,
    addedAt: row.addedAt,
  };
}
