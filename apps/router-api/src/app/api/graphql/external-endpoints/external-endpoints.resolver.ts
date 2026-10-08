import { Inject, Logger, NotFoundException, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  AdminGuard,
  CurrentUser,
  isAdminEmail,
  SessionGuard,
  type SessionUser,
  UserProfileService,
} from '../../../auth/index.js';
import { routerConfig } from '../../../config.js';
import type { EvidenceSnapshot } from '../../../db/entities/evidence-snapshot.entity.js';
import type { ExternalEndpointEvent } from '../../../db/entities/external-endpoint-event.entity.js';
import type { Model } from '../../../db/entities/model.entity.js';
import type { TrustedMeasurement } from '../../../db/entities/trusted-measurement.entity.js';
import { fingerprintHex } from '../../../evidence/index.js';
import {
  ExternalEndpointAdminService,
  type ExternalEndpointView,
  ExternalEvidenceService,
  ExternalModelDiscoveryService,
  type ExternalModelSpec,
} from '../../../external-endpoints/index.js';
import {
  AddTrustedMeasurementInputModel,
  DiscoveredExternalModelModel,
  ExternalEndpointEventModel,
  ExternalEndpointEvidenceModel,
  ExternalEndpointModel,
  type ExternalModelInputModel,
  ExternalModelModel,
  measurementSourceOf,
  PinExternalEndpointDigestInputModel,
  RegisterExternalEndpointInputModel,
  RotateExternalEndpointKeyInputModel,
  SetExternalEndpointEnabledInputModel,
  TrustedMeasurementModel,
  UpdateExternalEndpointInputModel,
  UpdateTrustedMeasurementInputModel,
} from './external-endpoints.model.js';

/**
 * How much of one endpoint's timeline `ExternalEndpoint.events` carries.
 *
 * A field rather than a paged query (the contract's `ExternalEndpoint.events`),
 * so the cap is the server's to choose: the table holds tens of rows per endpoint
 * and the drawer renders the recent history, not an audit export. The container
 * log is the audit trail (ADR-008 §7).
 */
const EVENT_LIMIT = 50;

/** Every OpenAI-compatible upstream serves chat; the rest an operator states. */
const DEFAULT_CAPABILITIES = ['chat'] as const;

/**
 * External model endpoints and the trust list that admits them (ADR-008 §7).
 *
 * Two audiences, and the split is the product decision rather than an
 * implementation detail (ruling 3 on SUP-221):
 *
 *  - **Any signed-in user reads.** The endpoint list with its status, the
 *    measurement and digest each verdict saw, the evidence summary behind it, the
 *    verdict timeline, and the trust list itself. An operator who could curate
 *    external capacity in secret is the configuration this product must not be
 *    able to sell as confidential — so transparency is `SessionGuard`, not
 *    `AdminGuard`.
 *  - **Only `auth.adminEmails` writes**, and `AdminGuard` is applied per method
 *    rather than per class precisely because the queries above are not admin-only.
 *    Two read fields are narrowed instead of the operation: the stored key's
 *    prefix and the name the upstream knows each model by. `isAdminEmail` is the
 *    same judgement the guard makes, so a screen cannot be offered a field whose
 *    mutation would be refused.
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

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    private readonly admin: ExternalEndpointAdminService,
    private readonly evidence: ExternalEvidenceService,
    private readonly discovery: ExternalModelDiscoveryService,
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

  @Query(() => [TrustedMeasurementModel], {
    name: 'trustedMeasurements',
    description:
      'The measurements this deployment accepts for an external upstream. Read-only for any signed-in user: a ' +
      'trust list only the operator can see is not a trust list anyone can audit.',
  })
  @UseGuards(SessionGuard)
  async trustedMeasurements(@CurrentUser() user: SessionUser): Promise<TrustedMeasurementModel[]> {
    const rows = await this.admin.listMeasurements();
    const [emails, usage] = await Promise.all([
      this.emailsOf(
        rows.map((row) => row.addedByUserId),
        user,
      ),
      this.admin.measurementUsage(),
    ]);
    return rows.map((row) => measurementModel(row, emails, usage));
  }

  @Query(() => [DiscoveredExternalModelModel], {
    name: 'discoverExternalModels',
    description:
      'Asks a VERIFIED_BY_THIS_ROUTER endpoint for its own GET /v1/models, through the attested egress — never ' +
      'before the verdict: an endpoint that is not verified is refused with CONFLICT and nothing is sent. ' +
      'Read-only; register the chosen models with updateExternalEndpoint. Restricted to auth.adminEmails, ' +
      'because the call carries the stored upstream key.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async discoverExternalModels(@Args('id', { type: () => ID }) id: string): Promise<DiscoveredExternalModelModel[]> {
    const models = await this.discovery.discover(id);
    return models.map((model) => ({
      ...model,
      promptPer1mMicros: model.promptPer1mMicros === null ? null : String(model.promptPer1mMicros),
      completionPer1mMicros: model.completionPer1mMicros === null ? null : String(model.completionPer1mMicros),
    }));
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
    description:
      'Re-points or re-prices an endpoint. The name is immutable — it is the sidecar’s key for this upstream. ' +
      'Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async updateExternalEndpoint(
    @CurrentUser() user: SessionUser,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateExternalEndpointInputModel,
  ): Promise<ExternalEndpointModel> {
    const view = await this.admin.update({
      id,
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
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: SetExternalEndpointEnabledInputModel,
  ): Promise<ExternalEndpointModel> {
    const view = await this.admin.setEnabled(id, input.enabled);
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
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: RotateExternalEndpointKeyInputModel,
  ): Promise<ExternalEndpointModel> {
    const view = await this.admin.rotateKey(id, input.apiKey);
    this.logger.warn(
      `External endpoint "${view.endpoint.name}" key rotated by ${user.email} — now ${view.endpoint.apiKeyPrefix}….`,
    );
    return this.presentOne(view, user);
  }

  @Mutation(() => ExternalEndpointModel, {
    description:
      'Approves one deployment: pins the evidence digest this endpoint must publish, the second trust factor ' +
      'beside the cloud measurement. Replaces any earlier pin — approving a redeploy is this call with the new ' +
      'digest. Takes effect on the next check, which the sidecar runs at once. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async pinExternalEndpointDigest(
    @CurrentUser() user: SessionUser,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: PinExternalEndpointDigestInputModel,
  ): Promise<ExternalEndpointModel> {
    const view = await this.admin.pinDigest(id, input.evidenceDigest);
    this.logger.warn(
      `External endpoint "${view.endpoint.name}" evidence digest ${view.endpoint.pinnedEvidenceDigest} pinned by ` +
        `${user.email}.`,
    );
    return this.presentOne(view, user);
  }

  @Mutation(() => TrustedMeasurementModel, {
    description:
      'Admits one more cloud — one of the two trust factors; each endpoint also needs its own deployment digest ' +
      'pinned (pinExternalEndpointDigest). ' +
      'Takes effect on the next check, not after the re-attest interval. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async addTrustedMeasurement(
    @CurrentUser() user: SessionUser,
    @Args('input') input: AddTrustedMeasurementInputModel,
  ): Promise<TrustedMeasurementModel> {
    const row = await this.admin.addMeasurement(input.measurement, input.note ?? null, user.id);
    this.logger.warn(`Trusted measurement ${row.measurement} added by ${user.email}.`);
    // A row this request created admits nothing yet: admission is re-derived by
    // the next check, and `admits` counts what the last one saw.
    return measurementModel(row, new Map([[user.id, user.email]]), await this.admin.measurementUsage());
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
    return measurementModel(row, await this.emailsOf([row.addedByUserId], user), await this.admin.measurementUsage());
  }

  /**
   * Withdraws a cloud.
   *
   * Answers `true` rather than the row it deleted, which is the contract's shape
   * and the honest one: the row is gone, so a payload describing it would be a
   * description of something that no longer exists, and a console that wrote it
   * back into its cache would re-add the entry it had just removed.
   */
  @Mutation(() => Boolean, {
    description:
      'Withdraws a cloud. Live and fail-closed: every endpoint admitted only by this measurement is denied on ' +
      'the next forced check, which drops its models from /v1/models. Restricted to auth.adminEmails.',
  })
  @UseGuards(SessionGuard, AdminGuard)
  async removeTrustedMeasurement(
    @CurrentUser() user: SessionUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    const row = await this.admin.removeMeasurement(id);
    this.logger.warn(`Trusted measurement ${row.measurement} withdrawn by ${user.email} — dependent upstreams deny.`);
    return true;
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
   * gets the whole endpoint minus what is about this deployment's own
   * configuration rather than about the upstream.
   *
   * Timelines and evidence summaries are loaded for the whole page in two
   * queries, eagerly, the way `CatalogViewService` loads an endpoint's latest
   * snapshot: they are fields of a type the console always asks for in full, and
   * a field resolver would turn one screen into one query per row.
   */
  private async present(views: ExternalEndpointView[], user: SessionUser): Promise<ExternalEndpointModel[]> {
    const admin = this.isAdmin(user);
    const timelines = await this.admin.eventsFor(
      views.map((view) => view.endpoint.id),
      EVENT_LIMIT,
    );
    const summaries = await this.evidence.summariesFor(wantedDigests(views, timelines));

    return views.map(({ endpoint, models }) => {
      const forEndpoint = summaries.get(endpoint.id);
      const events = timelines.get(endpoint.id) ?? [];
      return {
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
        measurementSource: measurementSourceOf(endpoint.measurementSource),
        evidenceDigestSeen: endpoint.evidenceDigestSeen,
        pinnedEvidenceDigest: endpoint.pinnedEvidenceDigest,
        pinnedEvidence: evidenceOf(forEndpoint, endpoint.pinnedEvidenceDigest),
        pinnedCertFingerprint: endpoint.pinnedCertFingerprint,
        apiKeyPrefix: admin ? endpoint.apiKeyPrefix : null,
        // Retired rows stay in the catalogue so past generations keep their
        // foreign key, but they are not part of what the operator lists — and
        // with no `enabled` field on the contract's type, a reader could not tell
        // them apart from what is on offer.
        models: models.filter((model) => model.enabled).map((model) => externalModel(model, admin)),
        events: events.map((event) => eventModel(event, evidenceOf(forEndpoint, event.evidenceDigest))),
        latestEvidence: evidenceOf(forEndpoint, endpoint.evidenceDigestSeen),
        createdAt: endpoint.createdAt,
        updatedAt: endpoint.updatedAt,
      };
    });
  }

  /**
   * Addresses for the operator fields, in one query — and only for an operator.
   *
   * A non-admin gets an empty map, so the lookup is not run at all: the account
   * that added a measurement is not part of the transparency ruling, and
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

/**
 * Every (endpoint, digest) pair the page will render: each endpoint's current
 * digest, its pinned one, plus the digest on every timeline entry.
 *
 * Asked for by digest rather than "the latest snapshot per endpoint" because a
 * timeline entry has to show the evidence *that* verdict saw, which is a
 * different publication from the current one as soon as a digest changes — and
 * showing today's images beside a `DIGEST_CHANGED` entry from last week would
 * make the one event cloud-granularity trust exists to surface unreadable.
 */
function wantedDigests(
  views: readonly ExternalEndpointView[],
  timelines: ReadonlyMap<string, ExternalEndpointEvent[]>,
): { externalEndpointId: string; evidenceDigest: string }[] {
  const wanted: { externalEndpointId: string; evidenceDigest: string }[] = [];
  for (const { endpoint } of views) {
    if (endpoint.evidenceDigestSeen) {
      wanted.push({ externalEndpointId: endpoint.id, evidenceDigest: endpoint.evidenceDigestSeen });
    }
    if (endpoint.pinnedEvidenceDigest) {
      wanted.push({ externalEndpointId: endpoint.id, evidenceDigest: endpoint.pinnedEvidenceDigest });
    }
    for (const event of timelines.get(endpoint.id) ?? []) {
      if (event.evidenceDigest) {
        wanted.push({ externalEndpointId: endpoint.id, evidenceDigest: event.evidenceDigest });
      }
    }
  }
  return wanted;
}

function evidenceOf(
  byDigest: ReadonlyMap<string, EvidenceSnapshot> | undefined,
  evidenceDigest: string | null,
): ExternalEndpointEvidenceModel | null {
  const snapshot = evidenceDigest ? byDigest?.get(evidenceDigest) : undefined;
  return snapshot ? evidenceModel(snapshot) : null;
}

function evidenceModel(snapshot: EvidenceSnapshot): ExternalEndpointEvidenceModel {
  return {
    snapshotId: snapshot.id,
    fetchedAt: snapshot.fetchedAt,
    issuedAt: snapshot.issuedAt,
    evidenceDigest: snapshot.evidenceDigest,
    evidenceDigestHex: snapshot.evidenceDigestHex,
    certFingerprint: snapshot.certFingerprint,
    // Derived rather than stored, as on `EvidenceSnapshot`: a second spelling of
    // a column the row already has, and the one every fingerprint screen asks
    // for (SUP-115).
    certFingerprintHex: fingerprintHex(snapshot.certFingerprint),
    quoteFormat: snapshot.quoteFormat,
    containerImages: snapshot.containerImages,
    // Null is "filed before the column existed", which is not something to
    // render as a difference — an operator reading it sees the same empty list a
    // producer that declares no workloads produces.
    workloads: snapshot.workloads ?? [],
    measurements: Object.entries(snapshot.measurements ?? {}).map(([name, value]) => ({
      name,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    })),
  };
}

function modelSpec(input: ExternalModelInputModel): ExternalModelSpec {
  return {
    id: input.id,
    name: input.name,
    upstreamModel: input.upstreamModel,
    contextLength: input.contextLength,
    capabilities: input.capabilities ?? [...DEFAULT_CAPABILITIES],
    promptPer1mMicros: Number(input.promptPer1mMicros),
    completionPer1mMicros: Number(input.completionPer1mMicros),
  };
}

function externalModel(row: Model, admin: boolean): ExternalModelModel {
  return {
    id: row.id,
    name: row.name,
    // What *another* operator's deployment calls this model: their business, and
    // narrowed for the same reason `apiKeyPrefix` is.
    upstreamModel: admin ? row.litellmModel : null,
    contextLength: row.contextLength,
    pricing: {
      promptPer1m: String(row.promptPer1mMicros),
      completionPer1m: String(row.completionPer1mMicros),
    },
    capabilities: row.capabilities,
  };
}

function eventModel(
  row: ExternalEndpointEvent,
  evidence: ExternalEndpointEvidenceModel | null,
): ExternalEndpointEventModel {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    stage: row.stage,
    reason: row.reason,
    measurement: row.measurement,
    evidenceDigest: row.evidenceDigest,
    evidence,
  };
}

function measurementModel(
  row: TrustedMeasurement,
  emails: Map<string, string>,
  usage: ReadonlyMap<string, number>,
): TrustedMeasurementModel {
  return {
    id: row.id,
    measurement: row.measurement,
    note: row.note,
    addedByEmail: (row.addedByUserId && emails.get(row.addedByUserId)) || null,
    addedAt: row.addedAt,
    admits: usage.get(row.measurement) ?? 0,
  };
}
