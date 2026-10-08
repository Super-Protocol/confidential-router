/**
 * The external-endpoint stand: a model endpoint in *someone else's* deployment,
 * attested by this router before a byte of a prompt goes to it (ADR-008).
 *
 *   OpenAI SDK ─▶ router-api ─▶ 127.0.0.1:<listen> ─▶ gatekeeper-sidecar ═TLS═▶ upstream
 *                     │              (real binary)          pinned leaf        │
 *                     └── renders config, polls /verdicts ──┘                  │
 *                                                                              │
 *   upstream = tools/mock-evidence-host  (publishes /.well-known/swarm-evidence)
 *            + tools/mock-litellm        (answers /v1 behind it)
 *              …behind one hostname, which is what makes the evidence a
 *              statement about the thing that serves the request.
 *
 * Everything on the router's side is the shipped artefact: `dist/main.js`
 * renders the sidecar config from its own database, the real
 * `gatekeeper-sidecar` watches that file and SIGHUPs the gatekeeper, and the
 * real verification pipeline decides. The one substitution is the attested-root
 * *hardware* leg, which no mock can produce — see
 * `apps/gatekeeper/cmd/gatekeeper-teststand`, the build-tagged binary this
 * module runs and the reason it exists.
 *
 * What the stand can make happen, because these are the beats worth testing:
 *
 *   rotateMeasurement()   the trusted cloud redeploys on an image nobody listed
 *                         → denied at `measurement-not-trusted`, models dropped,
 *                           in-flight cut
 *   denyAttestation()     the hardware report itself stops verifying
 *                         → denied at `untrusted-root`
 *   the upstream's own `rotateDeployment()` / `breakChannelBinding()` / … are
 *   unchanged and apply here too: the upstream is an ordinary mock evidence host.
 *   Under two-factor trust (SUP-252) `rotateDeployment()` is the redeploy beat:
 *   same cloud, new evidence digest → denied at `digest-mismatch` until an admin
 *   approves the new digest.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MockEvidenceHost, startMockEvidenceHost } from '@confidential-router/mock-evidence-host';
import { type MockLiteLLM, startMockLiteLLM } from '@confidential-router/mock-litellm';
import type { ConsoleSession } from './console-client.js';
import { delay, REPO_ROOT } from './router-process.js';
import { freePort, type RouterStack, type RouterStackOptions, startRouterStack } from './stack.js';

/** The two real binaries the stand drives. Built by `nx run gatekeeper:build` and `:build-teststand`. */
const GATEKEEPER_BIN_DIR = join(REPO_ROOT, 'apps', 'gatekeeper', 'bin');
export const SIDECAR_BIN = join(GATEKEEPER_BIN_DIR, 'gatekeeper-sidecar');
export const TESTSTAND_BIN = join(REPO_ROOT, 'apps', 'gatekeeper', 'bin-teststand', 'gatekeeper-teststand');

/** Where {@link TESTSTAND_BIN} reads the attested-root verdict from. */
const FIXTURE_ENV = 'GATEKEEPER_TESTSTAND_ATTESTED_ROOT';

/**
 * The measurement the stand's upstream cloud reports before anything rotates.
 *
 * A fixed value rather than a random one: it is what an admin pastes into the
 * trust list, and a failure that prints it is easier to read when the same
 * string turns up in the config, the verdict and the assertion.
 */
export const STAND_MEASUREMENT = '842c5f2e1d0b4a9c7e6f3d8b5a2c9e0f1b4d7a6c3e8f5b2d9a0c7e4f1b6d3a8c';

/** What `rotateMeasurement()` moves to: a different cloud image, equally well-formed. */
export const ROTATED_MEASUREMENT = 'bb6962eb20d616eb0f19479cf7fbccda50ee5682eab75b2104915d305a826aab';

/**
 * Short enough that the background loop is observable inside a test.
 *
 * These are the gatekeeper's own tuning knobs, set through its environment layer
 * (`CR_GATEKEEPER_*`) rather than written into the rendered file — router-api
 * renders `reattestInterval` from `externalEndpoints.reattestInterval`, which
 * Denis's ruling 6 bounds to [1 min, 1 h], and a stand is not an argument for
 * widening a product bound.
 */
const STAND_REATTEST_INTERVAL = '2s';
const STAND_VERDICT_CACHE_TTL = '1s';
/** How often the sidecar examines the rendered file. */
const STAND_WATCH_INTERVAL = '200ms';

/**
 * How long a status flip may take to reach the database.
 *
 * Generous against the two hops it crosses: the gatekeeper's own re-attestation
 * — immediate after a reload, otherwise within {@link STAND_REATTEST_INTERVAL} —
 * and router-api's status poll.
 */
const STATUS_TIMEOUT_MS = 30_000;

export interface ExternalUpstreamOptions {
  /** Milliseconds between streamed chunks; raise it to keep a generation alive. */
  chunkGapMs?: number;
  /** What the upstream lists on `GET /v1/models` — what the router discovers through the egress. */
  models?: readonly string[];
}

/** A model endpoint in another deployment: one TLS hostname, evidence and `/v1`. */
export interface ExternalUpstream {
  /** `https://localhost:<port>` — what an admin registers as `baseUrl`. */
  readonly url: string;
  readonly hostname: string;
  /** The OpenAI-compatible server behind the TLS front, and its recorded requests. */
  readonly backend: MockLiteLLM;
  /** The publisher, with every deny path of `tools/mock-evidence-host`. */
  readonly evidenceHost: MockEvidenceHost;
  stop(): Promise<void>;
}

/**
 * Starts the upstream: `mock-litellm` behind `mock-evidence-host`, one hostname.
 *
 * Fronting rather than side-by-side is the point. The evidence binds the TLS
 * leaf of the host that answers the request, so a bundle published on a
 * different port would be a statement about nothing the prompt ever reaches.
 */
export async function startExternalUpstream(options: ExternalUpstreamOptions = {}): Promise<ExternalUpstream> {
  const backend = await startMockLiteLLM({ chunkGapMs: options.chunkGapMs, models: options.models });
  try {
    const evidenceHost = await startMockEvidenceHost({ upstream: backend.url });
    return {
      url: evidenceHost.url,
      hostname: evidenceHost.hostname,
      backend,
      evidenceHost,
      async stop(): Promise<void> {
        await evidenceHost.close().catch(() => undefined);
        await backend.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await backend.close().catch(() => undefined);
    throw error;
  }
}

export interface EgressSidecarOptions {
  /** The rendered config router-api writes and the sidecar watches. */
  configFile: string;
  /** The measurement the stand's attested-root fixture reports. */
  measurement?: string;
  /** Mirror both processes' logs to stderr — what `--verbose` gives the demo. */
  echoLog?: boolean;
}

export interface EgressSidecar {
  /** The measurement the upstream cloud reports right now. */
  measurement(): string;
  /**
   * The trusted cloud redeploys on another VM image: a new launch measurement,
   * and nothing else about the upstream changed. Takes effect on the next
   * forced re-attestation, which the background loop runs every
   * {@link STAND_REATTEST_INTERVAL}.
   */
  rotateMeasurement(measurement?: string): string;
  /** The hardware report stops verifying altogether — denied at `untrusted-root`. */
  denyAttestation(reason?: string): void;
  /** Undo both: back to the measurement the stand started on. */
  restore(): void;
  /**
   * Resolves once the supervisor has the gatekeeper running.
   *
   * Not awaited at start-up, because it must not be: the sidecar waits for a
   * configuration the gatekeeper will *run*, and the first render of a
   * deployment with no external endpoint registered has an empty endpoint list.
   * "Started" is therefore something that happens after the first registration,
   * and a stand that demanded it earlier would be asserting the crash loop.
   */
  waitUntilStarted(timeoutMs?: number): Promise<void>;
  /** Everything the sidecar and the gatekeeper under it have written. */
  log(): string;
  stop(): Promise<void>;
}

/**
 * Runs the real `gatekeeper-sidecar` over the gatekeeper, pointed at the file
 * router-api renders.
 *
 * The sidecar is given its command explicitly (`-- <binary> …`), which is the
 * flag it already has for exactly this: the image's own entrypoint resolves
 * `gatekeeper` on PATH, and here the supervised process is the build-tagged
 * stand binary instead. Nothing else about the supervision differs — same file
 * watch, same SIGHUP, same shutdown path.
 */
export async function startEgressSidecar(options: EgressSidecarOptions): Promise<EgressSidecar> {
  const directory = mkdtempSync(join(tmpdir(), 'cr-egress-'));
  const fixturePath = join(directory, 'attested-root.json');
  let measurement = options.measurement ?? STAND_MEASUREMENT;

  const writeFixture = (verdict: Record<string, unknown>): void =>
    writeFileSync(fixturePath, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
  /*
   * `measurementSource: registry` and `inRegistry: true` deliberately: ruling 2
   * on SUP-221 makes the admin list the sole authority, so the stand reports the
   * strongest anchor there is and still expects a denial for a measurement
   * nobody listed. A fixture that said "nothing vouches for this" could not tell
   * the two apart.
   */
  const admit = (value: string): void =>
    writeFixture({ attested: true, measurement: value, measurementSource: 'registry', inRegistry: true });
  admit(measurement);

  const child = spawn(
    SIDECAR_BIN,
    ['--config', options.configFile, '--interval', STAND_WATCH_INTERVAL, '--', TESTSTAND_BIN, 'run', '--headless'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        [FIXTURE_ENV]: fixturePath,
        CR_GATEKEEPER_CONFIG: options.configFile,
        CR_GATEKEEPER_REATTEST_INTERVAL: STAND_REATTEST_INTERVAL,
        CR_GATEKEEPER_VERDICT_CACHE_TTL: STAND_VERDICT_CACHE_TTL,
        CR_GATEKEEPER_LOG_LEVEL: 'debug',
        CR_GATEKEEPER_LOG_FORMAT: 'text',
      },
    },
  );

  const buffer: string[] = [];
  const collect = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    buffer.push(text);
    if (options.echoLog) {
      process.stderr.write(text);
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const log = (): string => buffer.join('');
  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), delay(15_000)]);
      if (!exited) {
        child.kill('SIGKILL');
      }
    }
    rmSync(directory, { recursive: true, force: true });
  };

  const waitForLine = async (needles: readonly string[], timeoutMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (needles.some((needle) => log().includes(needle))) {
        return;
      }
      if (exited) {
        throw new Error(`the egress sidecar exited before it ${what}\n${log()}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`the egress sidecar never ${what} within ${timeoutMs}ms\n${log()}`);
      }
      await delay(100);
    }
  };

  // Either line proves the supervisor is up and reading the rendered file: it
  // started the gatekeeper, or it is waiting for a configuration with an
  // endpoint in it — which is where a stand with nothing registered yet belongs.
  try {
    await waitForLine(['sidecar: started', 'sidecar: waiting for'], 30_000, 'read the rendered configuration');
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    waitUntilStarted: (timeoutMs = 30_000) => waitForLine(['sidecar: started'], timeoutMs, 'started the gatekeeper'),
    measurement: () => measurement,
    rotateMeasurement(value = ROTATED_MEASUREMENT): string {
      measurement = value;
      admit(value);
      return value;
    },
    denyAttestation(reason = 'the stand withdrew the hardware report'): void {
      writeFixture({ attested: false, reason, measurement });
    },
    restore(): void {
      measurement = options.measurement ?? STAND_MEASUREMENT;
      admit(measurement);
    },
    log,
    stop,
  };
}

/** The `externalEndpoints` config block and the `CR_API_*` the stand needs. */
export interface ExternalSeam {
  configFile: string;
  adminListen: string;
  config: Record<string, unknown>;
  env: Record<string, string>;
  cleanup(): void;
}

/**
 * The router side of the seam: where the rendered file goes, where the admin
 * API is, and the key the upstream credential is sealed under.
 *
 * `CR_API_SECRETS_KEY` is an environment variable here for the same reason it is
 * a Secret in the chart: a rendered ConfigMap is readable inside the published
 * evidence (SUP-124), so the config file is the one place this key must never be
 * (ADR-008 §6).
 */
export async function externalSeam(): Promise<ExternalSeam> {
  const directory = mkdtempSync(join(tmpdir(), 'cr-sidecar-conf-'));
  const configFile = join(directory, 'config.yaml');
  const adminPort = await freePort();
  const listenPortBase = await freePort();
  const adminListen = `127.0.0.1:${adminPort}`;

  return {
    configFile,
    adminListen,
    config: {
      configFile,
      adminListen,
      // Ephemeral rather than the production default of 19000: two suites on one
      // machine must not allocate the same loopback listener.
      listenPortBase,
      listenPortRange: 16,
      // The product floor (ruling 6). The stand does not rely on it: every beat
      // it asserts is reached either by an admin edit, which re-renders the file
      // and reloads in place, or by the gatekeeper's own faster loop.
      reattestInterval: '1m',
      statusPollInterval: '500ms',
      evidencePollInterval: '2s',
    },
    env: {
      CR_API_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64url'),
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/* ------------------------------------------------------------------ *
 * The admin control plane, as the console drives it (ADR-008 §7).
 * ------------------------------------------------------------------ */

export interface ExternalModelRegistration {
  id: string;
  name: string;
  upstreamModel: string;
  contextLength?: number;
  capabilities?: string[];
  promptPer1mMicros?: number;
  completionPer1mMicros?: number;
}

export interface RegisteredExternalEndpoint {
  id: string;
  name: string;
  status: string;
  hostname: string;
  apiKeyPrefix: string | null;
  measurementSeen: string | null;
  measurementSource: string | null;
  /** The deployment digest the last check saw — what an admin pins (SUP-252). */
  evidenceDigestSeen: string | null;
  /** The deployment an admin approved; null until one is. */
  pinnedEvidenceDigest: string | null;
  lastStage: string | null;
  lastReason: string | null;
  models: { id: string; name: string }[];
  /** The evidence summary behind the digest seen, once the router has filed it. */
  latestEvidence: { evidenceDigest: string; containerImages: string[] } | null;
  /** The evidence summary behind the pinned digest. */
  pinnedEvidence: { evidenceDigest: string; containerImages: string[] } | null;
}

const ENDPOINT_FIELDS = `
  id
  name
  hostname
  status
  apiKeyPrefix
  measurementSeen
  measurementSource
  evidenceDigestSeen
  pinnedEvidenceDigest
  lastStage
  lastReason
  models { id name }
  latestEvidence { evidenceDigest containerImages }
  pinnedEvidence { evidenceDigest containerImages }
`;

/** `registerExternalEndpoint` — the register dialog's mutation, nothing else. */
export async function registerExternalEndpoint(
  session: ConsoleSession,
  input: { name: string; baseUrl: string; apiKey: string; models: ExternalModelRegistration[] },
): Promise<RegisteredExternalEndpoint> {
  const { registerExternalEndpoint: registered } = await session.graphql<{
    registerExternalEndpoint: RegisteredExternalEndpoint;
  }>(
    `mutation Register($input: RegisterExternalEndpointInput!) {
       registerExternalEndpoint(input: $input) { ${ENDPOINT_FIELDS} }
     }`,
    {
      input: {
        name: input.name,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        models: input.models.map((model) => ({
          id: model.id,
          name: model.name,
          upstreamModel: model.upstreamModel,
          contextLength: model.contextLength ?? 131_072,
          capabilities: model.capabilities ?? ['CHAT'],
          // Micro-USD arrive as strings: a price is money, and `Int` is not
          // where money belongs (console-graphql.md).
          promptPer1mMicros: String(model.promptPer1mMicros ?? 400_000),
          completionPer1mMicros: String(model.completionPer1mMicros ?? 800_000),
        })),
      },
    },
  );
  return registered;
}

export async function readExternalEndpoint(
  session: ConsoleSession,
  id: string,
): Promise<RegisteredExternalEndpoint | null> {
  const { externalEndpoint } = await session.graphql<{ externalEndpoint: RegisteredExternalEndpoint | null }>(
    `query External($id: ID!) { externalEndpoint(id: $id) { ${ENDPOINT_FIELDS} } }`,
    { id },
  );
  return externalEndpoint;
}

export async function externalEndpointEvents(
  session: ConsoleSession,
  id: string,
): Promise<{ kind: string; stage: string | null; reason: string | null; measurement: string | null }[]> {
  const { externalEndpoint } = await session.graphql<{
    externalEndpoint: {
      events: { kind: string; stage: string | null; reason: string | null; measurement: string | null }[];
    } | null;
  }>(`query Events($id: ID!) { externalEndpoint(id: $id) { events { kind stage reason measurement } } }`, { id });
  return externalEndpoint?.events ?? [];
}

export async function addTrustedMeasurement(
  session: ConsoleSession,
  measurement: string,
  note = 'the stand upstream cloud',
): Promise<{ id: string; measurement: string }> {
  const { addTrustedMeasurement: added } = await session.graphql<{
    addTrustedMeasurement: { id: string; measurement: string };
  }>(
    `mutation Trust($input: AddTrustedMeasurementInput!) {
       addTrustedMeasurement(input: $input) { id measurement note }
     }`,
    { input: { measurement, note } },
  );
  return added;
}

/**
 * `pinExternalEndpointDigest` — the dossier's "Pin this digest" / "Approve new
 * digest" (SUP-252). Approves one deployment; the sidecar re-attests at once.
 */
export async function pinExternalEndpointDigest(
  session: ConsoleSession,
  id: string,
  evidenceDigest: string,
): Promise<RegisteredExternalEndpoint> {
  const { pinExternalEndpointDigest: pinned } = await session.graphql<{
    pinExternalEndpointDigest: RegisteredExternalEndpoint;
  }>(
    `mutation Pin($id: ID!, $input: PinExternalEndpointDigestInput!) {
       pinExternalEndpointDigest(id: $id, input: $input) { ${ENDPOINT_FIELDS} }
     }`,
    { id, input: { evidenceDigest } },
  );
  return pinned;
}

/** `discoverExternalModels` — the register dialog's attest-then-list call (SUP-249). */
export async function discoverExternalModels(
  session: ConsoleSession,
  id: string,
): Promise<{ upstreamModel: string; registeredAs: string | null }[]> {
  const { discoverExternalModels: models } = await session.graphql<{
    discoverExternalModels: { upstreamModel: string; registeredAs: string | null }[];
  }>('query Discover($id: ID!) { discoverExternalModels(id: $id) { upstreamModel registeredAs } }', { id });
  return models;
}

export async function removeTrustedMeasurement(session: ConsoleSession, id: string): Promise<boolean> {
  const { removeTrustedMeasurement: removed } = await session.graphql<{ removeTrustedMeasurement: boolean }>(
    'mutation Withdraw($id: ID!) { removeTrustedMeasurement(id: $id) }',
    { id },
  );
  return removed;
}

/**
 * Polls `externalEndpoint(id)` until its status is one of `wanted`.
 *
 * Polling, not a subscription or a log grep: the status an admin sees is the
 * projection of the sidecar's `/verdicts` into the database, and that projection
 * — not the gatekeeper's own log line — is what every screen and `/v1/models`
 * read (ADR-008 §6).
 */
export async function waitForExternalStatus(
  session: ConsoleSession,
  id: string,
  wanted: readonly string[],
): Promise<RegisteredExternalEndpoint> {
  return waitForExternal(session, id, {
    until: (endpoint) => wanted.includes(endpoint.status),
    wanted: `one of ${wanted.join(' / ')}`,
  });
}

/**
 * Polls `externalEndpoint(id)` until `until` holds — for the states a status
 * alone cannot name: `PENDING` *at* `digest-not-pinned` with both factors seen,
 * or a summary the evidence poller has filed (SUP-252).
 */
export async function waitForExternal(
  session: ConsoleSession,
  id: string,
  { until, wanted }: { until: (endpoint: RegisteredExternalEndpoint) => boolean; wanted: string },
): Promise<RegisteredExternalEndpoint> {
  const timeoutMs = STATUS_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let last: RegisteredExternalEndpoint | null = null;
  for (;;) {
    last = await readExternalEndpoint(session, id);
    if (last && until(last)) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `external endpoint ${id} was ${last?.status ?? 'absent'} after ${timeoutMs}ms, wanted ${wanted}` +
          `${last?.lastReason ? ` (last reason: ${last.lastStage}: ${last.lastReason})` : ''}`,
      );
    }
    await delay(200);
  }
}

/* ------------------------------------------------------------------ *
 * The whole stand, assembled.
 * ------------------------------------------------------------------ */

export interface ExternalStandOptions {
  /** Milliseconds between the upstream's streamed chunks. */
  chunkGapMs?: number;
  /** What the upstream lists on `GET /v1/models`. */
  upstreamModels?: readonly string[];
  /** Mirror every process's log to stderr. */
  verbose?: boolean;
  /** Extra `RouterStackOptions`, merged over the stand's own. */
  stack?: Omit<RouterStackOptions, 'adminEmails' | 'externalEndpoints' | 'extraTrustedRootsPem'>;
}

export interface ExternalStand {
  /** router-api as a process, with a signed-in admin, credits and a `/v1` key. */
  readonly stack: RouterStack;
  /** The model endpoint in the other deployment. */
  readonly upstream: ExternalUpstream;
  /** The attesting egress, as the two real binaries. */
  readonly sidecar: EgressSidecar;
  /**
   * The console session, which is an admin: `auth.adminEmails` carries its
   * address, so the control plane's `AdminGuard` admits it (ADR-008 §7).
   */
  readonly admin: ConsoleSession;
  stop(): Promise<void>;
}

/**
 * Brings up the upstream, the router and the egress, in the order their
 * dependencies force.
 *
 * The upstream first, because the router needs its root in the trust store to
 * fetch the published bundle at all. The router next, because the sidecar's
 * configuration is a *rendered* file and router-api is what renders it. The
 * sidecar last — and it waits for the file rather than requiring it, which is
 * the same race the pod has and the reason `pkg/sidecar` waits at all.
 */
export async function startExternalStand(options: ExternalStandOptions = {}): Promise<ExternalStand> {
  const started: (() => Promise<void>)[] = [];
  const unwind = async (): Promise<void> => {
    for (const stop of started.reverse()) {
      await stop().catch(() => undefined);
    }
  };

  try {
    const upstream = await startExternalUpstream({ chunkGapMs: options.chunkGapMs, models: options.upstreamModels });
    started.push(() => upstream.stop());

    const seam = await externalSeam();
    started.push(async () => seam.cleanup());

    const email = `admin-${Date.now().toString(36)}@confidential-router.local`;
    const stack = await startRouterStack({
      ...options.stack,
      email,
      adminEmails: [email],
      externalEndpoints: seam.config,
      extraTrustedRootsPem: [upstream.evidenceHost.trustedRootPem],
      echoRouterLog: options.verbose,
      env: { ...seam.env, ...options.stack?.env },
    });
    started.push(() => stack.stop());

    const sidecar = await startEgressSidecar({ configFile: seam.configFile, echoLog: options.verbose });
    started.push(() => sidecar.stop());

    return { stack, upstream, sidecar, admin: stack.session, stop: unwind };
  } catch (error) {
    await unwind();
    throw error;
  }
}
