import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, Not } from 'typeorm';
import { routerConfig } from '../config.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { ExternalEndpointEvent } from '../db/entities/external-endpoint-event.entity.js';
import { Model, type ModelCapability } from '../db/entities/model.entity.js';
import { TrustedMeasurement } from '../db/entities/trusted-measurement.entity.js';
import { MissingSecretsKeyError, SecretEnvelopeService } from '../secrets/index.js';
import { ExternalCatalogService } from './external-catalog.service.js';
import { ExternalEndpointStatusService } from './external-endpoint-status.service.js';
import { allocateListenPort } from './listen-port.js';
import { InvalidMeasurementError, normaliseMeasurement } from './measurement.js';
import { SidecarConfigWriterService } from './sidecar-config-writer.service.js';

/** The sidecar's endpoint key is a Rego key: `schemas/gatekeeper-config.schema.json` `$defs/name`. */
export const EXTERNAL_ENDPOINT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * What an external catalogue row records under `models.tee`.
 *
 * Empty, because nobody is in a position to fill it: the admin does not declare
 * an upstream's hardware (the API has no field for it) and the router cannot
 * observe it. `/v1/models` omits the key rather than publishing a blank, and
 * `ExternalEndpoint.measurementSeen` is where the console reads what the verdict
 * actually saw.
 */
export const EXTERNAL_MODEL_TEE = '';

/** One model an admin registers on an external endpoint, with the prices the ledger will freeze. */
export interface ExternalModelSpec {
  /** The public model id, i.e. the primary key of `models`. */
  id: string;
  name: string;
  /** What the *upstream* calls it; the egress leg rewrites `model` to this. */
  upstreamModel: string;
  contextLength: number;
  capabilities: ModelCapability[];
  promptPer1mMicros: number;
  completionPer1mMicros: number;
}

export interface RegisterExternalEndpointSpec {
  name: string;
  baseUrl: string;
  /** The upstream's own LLM API key — sealed before it reaches a column, never read back. */
  apiKey: string;
  models: readonly ExternalModelSpec[];
  createdByUserId: string | null;
}

export interface UpdateExternalEndpointSpec {
  id: string;
  baseUrl?: string;
  /** Replaces the registered set. A model dropped here is retired, never deleted. */
  models?: readonly ExternalModelSpec[];
}

/**
 * Back to "no live verdict": every column the status poll owns, cleared.
 *
 * The same reset `ExternalEndpointStatusService.resetToPending` applies on boot,
 * because the three occasions are one rule — a verdict is only ever a statement
 * about the upstream *as it is now*, so anything that changes which upstream this
 * is, or whether it is being watched, throws the old one away (ADR-008 §8).
 */
const PENDING_VERDICT = {
  status: 'pending',
  lastCheckedAt: null,
  lastStage: null,
  lastReason: null,
  measurementSeen: null,
  measurementSource: null,
  evidenceDigestSeen: null,
  pinnedCertFingerprint: null,
} as const satisfies Partial<ExternalEndpoint>;

/** The four values both catalogue writes need, grouped so neither takes four positional arguments. */
interface ModelWrite {
  manager: DataSource['manager'];
  externalEndpointId: string;
  models: readonly ExternalModelSpec[];
  now: Date;
}

/** An endpoint with the catalogue rows that hang off it — what the admin screen lists. */
export interface ExternalEndpointView {
  endpoint: ExternalEndpoint;
  models: Model[];
}

/**
 * Everything an operator can *change* about external endpoints and the trust list
 * (ADR-008 §7).
 *
 * The rest of this directory reads: the renderer turns rows into the sidecar's
 * config, the poller turns the sidecar's verdicts back into rows. This is the one
 * writer, and it owns three obligations that are easy to get half-right:
 *
 *  - **Every mutation re-renders.** A trust-list edit that did not reach the file
 *    would take effect at the next TTL instead of the next check, which is the
 *    latency ruling 6 bounds and ADR-008 §5 promises. The render is therefore part
 *    of the mutation, not a background tidy-up.
 *  - **Enabling re-attests from nothing.** An endpoint coming back on is returned
 *    to `pending` with its verdict columns cleared, exactly as a restart does
 *    (§8): the verdict it had before it was switched off is not evidence about the
 *    upstream now.
 *  - **The API key only ever travels inwards.** It is sealed in this class and
 *    opened in the egress leg; nothing here returns it, logs it, or puts it in an
 *    error. `apiKeyPrefix` is the only part that comes back out.
 */
@Injectable()
export class ExternalEndpointAdminService {
  private readonly logger = new Logger(ExternalEndpointAdminService.name);

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly secrets: SecretEnvelopeService,
    private readonly renderer: SidecarConfigWriterService,
    private readonly catalog: ExternalCatalogService,
    private readonly status: ExternalEndpointStatusService,
  ) {}

  /** Every registered endpoint with its catalogue rows, by name. */
  async list(): Promise<ExternalEndpointView[]> {
    const endpoints = await this.endpoints().find({ order: { name: 'ASC' } });
    const models = endpoints.length
      ? await this.models().find({
          where: { origin: 'external', externalEndpointId: In(endpoints.map((row) => row.id)) },
          order: { id: 'ASC' },
        })
      : [];
    return endpoints.map((endpoint) => ({
      endpoint,
      models: models.filter((model) => model.externalEndpointId === endpoint.id),
    }));
  }

  async find(id: string): Promise<ExternalEndpointView | null> {
    const endpoint = await this.endpoints().findOne({ where: { id } });
    if (!endpoint) {
      return null;
    }
    return {
      endpoint,
      models: await this.models().find({ where: { origin: 'external', externalEndpointId: id }, order: { id: 'ASC' } }),
    };
  }

  /**
   * The verdict timelines of several endpoints at once, newest first — history,
   * never an input to admission (§8).
   *
   * One bounded read per endpoint rather than one unbounded read for the page.
   * The timeline is a field of `ExternalEndpoint` (the contract's
   * `ExternalEndpoint.events`) and `externalEndpoints` is `SessionGuard`, so any
   * signed-in user asks for every endpoint's at once — and nothing prunes
   * `external_endpoint_events`, which the status poller appends to on every flip.
   * A single `IN` query would therefore hydrate the whole table to throw most of
   * it away. `LIMIT` per row-group needs a window function, which the two drivers
   * spell differently; N indexed reads of 50 rows
   * (`IDX_external_endpoint_events_endpointId_at`) are the portable version, and N
   * is the registration count.
   */
  async eventsFor(
    externalEndpointIds: readonly string[],
    limit: number,
  ): Promise<Map<string, ExternalEndpointEvent[]>> {
    const repository = this.dataSource.getRepository(ExternalEndpointEvent);
    const timelines = await Promise.all(
      externalEndpointIds.map(async (externalEndpointId) =>
        repository.find({
          where: { externalEndpointId },
          order: { at: 'DESC', id: 'DESC' },
          take: limit,
        }),
      ),
    );
    return new Map(externalEndpointIds.map((id, index) => [id, timelines[index] ?? []]));
  }

  /**
   * Registers an upstream. It serves nothing yet: the row starts `pending` and the
   * sidecar has to come back with a verdict first (§8, decision 5).
   */
  async register(spec: RegisterExternalEndpointSpec): Promise<ExternalEndpointView> {
    this.requireSecretsKey();
    const name = this.requireName(spec.name);
    const baseUrl = canonicalBaseUrl(spec.baseUrl);
    const apiKey = spec.apiKey.trim();
    if (!apiKey) {
      throw new BadRequestException('The upstream API key must not be blank; the router cannot proxy without it.');
    }
    assertDistinctModelIds(spec.models);

    if (await this.endpoints().findOne({ where: { name }, select: { id: true } })) {
      throw new ConflictException(`An external endpoint named "${name}" is already registered.`);
    }
    await this.assertModelIdsFree(spec.models, null);

    const id = randomUUID();
    const listenPort = await this.allocatePort();
    // Sealed under the row id, so the ciphertext cannot be moved to another
    // endpoint's row and hand that upstream this credential (`secret-envelope.ts`).
    const sealed = this.secrets.seal(apiKey, id);
    const now = new Date();

    await this.dataSource.transaction(async (manager) => {
      await manager.save(ExternalEndpoint, {
        id,
        name,
        baseUrl,
        hostname: new URL(baseUrl).hostname,
        listenPort,
        enabled: true,
        status: 'pending',
        lastCheckedAt: null,
        lastStage: null,
        lastReason: null,
        measurementSeen: null,
        measurementSource: null,
        evidenceDigestSeen: null,
        pinnedCertFingerprint: null,
        apiKeyCiphertext: sealed.ciphertext,
        apiKeyPrefix: sealed.prefix,
        createdByUserId: spec.createdByUserId,
        createdAt: now,
        updatedAt: now,
      });
      await this.writeModels({ manager, externalEndpointId: id, models: spec.models, now });
    });

    await this.status.recordEvent(id, 'registered', now);
    await this.publish();
    return this.view(id);
  }

  /**
   * Renames, re-points or re-prices an endpoint. The key is not touched here — see
   * {@link rotateKey}.
   *
   * **Re-pointing resets the verdict.** A row that still said `verified` while
   * `baseUrl` named a different host would be vouching for host A about traffic
   * going to host B — and `ExternalCatalogService` reads exactly that column to
   * decide admission, so the models would stay routable across the change. The
   * sidecar would refuse (it discards every cached verdict on reload and
   * re-attests), but the two refusals decision 5 relies on have to agree: the row
   * goes back to `pending` with its verdict columns cleared, the same reset a
   * restart and a re-enable do.
   *
   * The name is **not** among the things this changes, and the contract says so
   * out loud (`UpdateExternalEndpointInput` has no `name`): it is also the
   * sidecar's key for the upstream and the id the rendered config, the allocated
   * listener and every timeline entry are written against. Re-keying all of that
   * to spell a label differently is a registration, not an edit.
   */
  async update(spec: UpdateExternalEndpointSpec): Promise<ExternalEndpointView> {
    const endpoint = await this.require(spec.id);
    const baseUrl = spec.baseUrl === undefined ? endpoint.baseUrl : canonicalBaseUrl(spec.baseUrl);

    if (spec.models) {
      assertDistinctModelIds(spec.models);
      await this.assertModelIdsFree(spec.models, endpoint.id);
    }

    const now = new Date();
    const repointed = baseUrl !== endpoint.baseUrl;
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        ExternalEndpoint,
        { id: endpoint.id },
        {
          baseUrl,
          hostname: new URL(baseUrl).hostname,
          ...(repointed && endpoint.enabled ? PENDING_VERDICT : {}),
          updatedAt: now,
        },
      );
      if (spec.models) {
        const write = { manager, externalEndpointId: endpoint.id, models: spec.models, now };
        await this.writeModels(write);
        await this.retireModels(write);
      }
    });

    await this.publish();
    return this.view(endpoint.id);
  }

  /**
   * The operator's switch.
   *
   * Off is rendered as absence: a disabled endpoint is left out of the sidecar
   * config entirely, so no stale verdict can reach it. On is rendered as
   * `pending`, because the verdict it held before it went off is not a statement
   * about the upstream now.
   */
  async setEnabled(id: string, enabled: boolean): Promise<ExternalEndpointView> {
    const endpoint = await this.require(id);
    if (endpoint.enabled === enabled) {
      return this.view(id);
    }
    const now = new Date();
    await this.endpoints().update(
      { id },
      { ...PENDING_VERDICT, enabled, status: enabled ? 'pending' : 'disabled', updatedAt: now },
    );
    if (!enabled) {
      await this.status.recordEvent(id, 'disabled', now);
    }
    await this.publish();
    return this.view(id);
  }

  /**
   * Replaces the stored upstream key.
   *
   * Rotation is a write and nothing else — there is no "current key" to compare
   * against, because no read path returns one. The sidecar config holds no
   * secrets, so this does not re-render it; the egress leg opens the envelope per
   * request and therefore picks the new key up on the next one.
   */
  async rotateKey(id: string, apiKey: string): Promise<ExternalEndpointView> {
    this.requireSecretsKey();
    const endpoint = await this.require(id);
    const plaintext = apiKey.trim();
    if (!plaintext) {
      throw new BadRequestException('The upstream API key must not be blank; the router cannot proxy without it.');
    }
    const sealed = this.secrets.seal(plaintext, endpoint.id);
    const now = new Date();
    await this.endpoints().update(
      { id },
      { apiKeyCiphertext: sealed.ciphertext, apiKeyPrefix: sealed.prefix, updatedAt: now },
    );
    await this.status.recordEvent(id, 'key_rotated', now);
    return this.view(id);
  }

  /** The admin trust list, in the order the rendered config lists it. */
  async listMeasurements(): Promise<TrustedMeasurement[]> {
    return this.measurements().find({ order: { measurement: 'ASC' } });
  }

  /**
   * How many registered endpoints each measurement currently admits — what
   * removing one would drop (`TrustedMeasurement.admits`).
   *
   * Counted from the measurement each endpoint's **last verdict saw**, which
   * makes this a statement about the last check and not a promise about the next
   * one. That is the only honest count available: admission happens in the
   * sidecar against the list as it stands at that moment, so "what this row will
   * admit" is not knowable here — and a console number that implied otherwise
   * would be re-introducing the stored trust ADR-008 §8 refuses.
   *
   * Only endpoints a verdict currently admits are counted. A denied one keeps the
   * measurement its last check saw — a refusal at `tls-fingerprint` or `policy`
   * observed one and refused anyway — and counting it would make the field say
   * that withdrawing the row would drop an endpoint that is already serving
   * nothing. `disabled` rows are out for the same reason.
   */
  async measurementUsage(): Promise<Map<string, number>> {
    const rows = await this.endpoints()
      .createQueryBuilder('endpoint')
      .select('endpoint.measurementSeen', 'measurement')
      .addSelect('COUNT(*)', 'admits')
      .where('endpoint.measurementSeen IS NOT NULL')
      .andWhere('endpoint.enabled = :enabled', { enabled: true })
      .andWhere('endpoint.status = :status', { status: 'verified' })
      .groupBy('endpoint.measurementSeen')
      .getRawMany<{ measurement: string; admits: string | number }>();
    return new Map(rows.map((row) => [row.measurement, Number(row.admits)]));
  }

  /**
   * Admits one more cloud.
   *
   * Normalised first: the unique index is what makes a repeat a conflict rather
   * than a second row, and an index cannot fold `0x…` onto `…` itself.
   */
  async addMeasurement(
    measurement: string,
    note: string | null,
    addedByUserId: string | null,
  ): Promise<TrustedMeasurement> {
    const normalised = this.requireMeasurement(measurement);
    if (await this.measurements().findOne({ where: { measurement: normalised }, select: { id: true } })) {
      throw new ConflictException(`The measurement ${normalised} is already on the trust list.`);
    }
    const row: TrustedMeasurement = {
      id: randomUUID(),
      measurement: normalised,
      note: note?.trim() || null,
      addedByUserId,
      addedAt: new Date(),
    };
    await this.measurements().save(row);
    await this.publish();
    return row;
  }

  /** Rewrites the operator's own words beside an entry. The measurement itself is immutable. */
  async updateMeasurementNote(id: string, note: string | null): Promise<TrustedMeasurement> {
    const row = await this.measurements().findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Trusted measurement not found.');
    }
    row.note = note?.trim() || null;
    await this.measurements().save(row);
    // No re-render: the note is not part of the rendered config, and re-rendering
    // identical bytes would be a no-op the writer already skips.
    return row;
  }

  /**
   * Withdraws a cloud. A live, fail-closed action: every endpoint admitted only by
   * this measurement is denied on the next forced check, which drops its models.
   */
  async removeMeasurement(id: string): Promise<TrustedMeasurement> {
    const row = await this.measurements().findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Trusted measurement not found.');
    }
    await this.measurements().delete({ id });
    await this.publish();
    return row;
  }

  /**
   * Re-renders the sidecar config and rebuilds the external catalogue.
   *
   * In this order, and both of them, after every mutation that can change what the
   * sidecar admits: the file is what makes the edit live, and the map is what
   * `/v1/models` and admission read.
   *
   * A render failure is allowed to fail the mutation even though the row is
   * already committed, and the direction that makes it safe is fail-closed: an
   * endpoint the sidecar has not been told about serves nothing. The renderer is a
   * full rewrite from the database, so the next mutation — or the next boot —
   * publishes the committed state, and the error is what tells the operator the
   * egress config could not be written rather than leaving them to find out from
   * an endpoint that never leaves `pending`.
   */
  private async publish(): Promise<void> {
    const result = await this.renderer.render();
    const routable = await this.catalog.refresh();
    this.logger.log(
      `External endpoints: ${result.endpoints} rendered, ${result.trustedMeasurements} trusted measurement(s), ` +
        `${routable} routable model(s)${result.changed ? '' : ' (config unchanged)'}.`,
    );
  }

  private async view(id: string): Promise<ExternalEndpointView> {
    const view = await this.find(id);
    if (!view) {
      throw new NotFoundException('External endpoint not found.');
    }
    return view;
  }

  private async require(id: string): Promise<ExternalEndpoint> {
    const endpoint = await this.endpoints().findOne({ where: { id } });
    if (!endpoint) {
      throw new NotFoundException('External endpoint not found.');
    }
    return endpoint;
  }

  private requireName(value: string): string {
    const name = value.trim().toLowerCase();
    if (!EXTERNAL_ENDPOINT_NAME.test(name)) {
      throw new BadRequestException(
        `"${value}" is not a usable endpoint name: lower-case letters, digits and hyphens only, ` +
          'starting with a letter or digit, at most 63 characters — it is the sidecar’s own key for this upstream.',
      );
    }
    return name;
  }

  private requireMeasurement(value: string): string {
    try {
      return normaliseMeasurement(value);
    } catch (error) {
      throw error instanceof InvalidMeasurementError ? new BadRequestException(error.message) : error;
    }
  }

  private requireSecretsKey(): void {
    if (!this.secrets.available()) {
      // 503 rather than 500: the deployment is missing configuration, and the
      // message is the one an operator can act on (`console-graphql.md`).
      throw new ServiceUnavailableException(new MissingSecretsKeyError().message);
    }
  }

  /** The lowest free loopback port, recorded on the row so a restart renders the same file. */
  private async allocatePort(): Promise<number> {
    const taken = (await this.endpoints().find({ select: { listenPort: true } })).map((row) => row.listenPort);
    return allocateListenPort(
      this.config.externalEndpoints.listenPortBase,
      this.config.externalEndpoints.listenPortRange,
      taken,
    );
  }

  /**
   * A model id is the primary key of one shared catalogue table, so an external
   * registration must not take an id a config model already holds — that row
   * would be overwritten and `/v1/models` would quietly re-point a built-in.
   */
  private async assertModelIdsFree(models: readonly ExternalModelSpec[], ownEndpointId: string | null): Promise<void> {
    if (models.length === 0) {
      return;
    }
    const clashes = await this.models().find({
      where: { id: In(models.map((model) => model.id)) },
      select: { id: true, origin: true, externalEndpointId: true },
    });
    const taken = clashes.filter((row) => row.origin !== 'external' || row.externalEndpointId !== ownEndpointId);
    if (taken.length > 0) {
      throw new ConflictException(
        `These model ids are already in the catalogue: ${taken.map((row) => row.id).join(', ')}.`,
      );
    }
  }

  private async writeModels({ manager, externalEndpointId, models, now }: ModelWrite): Promise<void> {
    for (const model of models) {
      await manager.save(Model, {
        id: model.id,
        name: model.name,
        litellmModel: model.upstreamModel,
        // Stated, not defaulted: `origin` is what keeps the boot projection's
        // retire pass off these rows (invariant 4, `catalog.service.ts`).
        origin: 'external',
        endpointId: null,
        externalEndpointId,
        contextLength: model.contextLength,
        capabilities: model.capabilities,
        promptPer1mMicros: model.promptPer1mMicros,
        completionPer1mMicros: model.completionPer1mMicros,
        // Blank, and deliberately: an external model's hardware is not something
        // an admin declares (the contract's `ExternalModelInput` has no `tee`) or
        // this router can know. What it *can* say about the upstream is the
        // measurement a verdict saw, which is a column on the endpoint. A label
        // invented here would read as a claim on `/v1/models`, so the field is
        // omitted there instead (`models.controller.ts`).
        tee: EXTERNAL_MODEL_TEE,
        enabled: true,
        updatedAt: now,
      });
    }
  }

  /**
   * A model the admin no longer lists is disabled, not deleted — generations keep
   * their foreign key, the same trade the config projection makes.
   */
  private async retireModels({ manager, externalEndpointId, models, now }: ModelWrite): Promise<void> {
    const keptIds = models.map((model) => model.id);
    // `Not(In([]))` is not a valid predicate on either driver, so an empty list
    // retires the endpoint's whole catalogue — which is what it asked for.
    const where =
      keptIds.length > 0
        ? { externalEndpointId, enabled: true, id: Not(In(keptIds)) }
        : { externalEndpointId, enabled: true };
    await manager.update(Model, where, { enabled: false, updatedAt: now });
  }

  private endpoints() {
    return this.dataSource.getRepository(ExternalEndpoint);
  }

  private models() {
    return this.dataSource.getRepository(Model);
  }

  private measurements() {
    return this.dataSource.getRepository(TrustedMeasurement);
  }
}

/**
 * `https://host[:port]` and nothing else.
 *
 * The path is dropped rather than refused because the OpenAI base URL an operator
 * has in hand usually ends in `/v1`, and the sidecar binds a *channel*: it needs
 * the authority, and anything after it would be rendered away anyway
 * (`sidecar-config.ts`). Plain HTTP is refused outright — there is no TLS leaf to
 * pin, so the verdict would be about nothing.
 */
export function canonicalBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestException(`"${value}" is not a URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new BadRequestException(
      `"${value}" is not an https URL. The router pins the upstream’s TLS certificate to its evidence, ` +
        'and a plain-HTTP upstream has no channel to bind a verdict to.',
    );
  }
  return `${url.protocol}//${url.host}`;
}

function assertDistinctModelIds(models: readonly ExternalModelSpec[]): void {
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) {
      throw new BadRequestException(`The model id "${model.id}" is listed twice.`);
    }
    seen.add(model.id);
  }
}
