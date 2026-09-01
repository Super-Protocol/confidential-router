/**
 * The whole product, on one machine, out of processes.
 *
 *   OpenAI SDK ─▶ gatekeeper ─▶ mock-evidence-host (TLS) ─▶ router-api ─▶ mock-litellm
 *                     │                  │
 *                     └── verifies ──────┘  /.well-known/swarm-evidence
 *
 * This module owns everything left of the gatekeeper: the two stand-ins, the
 * router process behind them, and a signed-in console session with credits and
 * a key. `apps/router-api-e2e` uses it to test the router across a real process
 * boundary; `story.ts` adds the gatekeeper on top for the demo.
 *
 * The catalogue is fixed here rather than read from `conf/router.dev-seed.yaml`
 * so the expectations in the suites have something stable to name.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MockEvidenceHost, startMockEvidenceHost } from '@confidential-router/mock-evidence-host';
import { type MockLiteLLM, startMockLiteLLM, type UpstreamFailure } from '@confidential-router/mock-litellm';
import { type ConsoleSession, createApiKey, type DemoCredential, signIn, topUp } from './console-client.js';
import { EVIDENCE_PATH_SUFFIX } from './constants.js';
import { type RouterProcess, startRouterProcess } from './router-process.js';

/** The endpoint every model in the demo catalogue is served by. */
export const DEMO_ENDPOINT = 'demo-tee';
/** The model id a client asks the router for. */
export const DEMO_MODEL = 'meta/llama-3.3-70b-instruct:tdx';
/** What that resolves to on the LiteLLM side. */
export const DEMO_UPSTREAM_MODEL = 'vllm/llama-3.3-70b-instruct';
/** A model wired to a backend failure, for the error-path assertions. */
export const FAILING_MODEL = 'meta/llama-3.3-70b-instruct:broken';
export const FAILING_UPSTREAM_MODEL = 'vllm/broken';

/**
 * The origin the headless console session presents. It is listed in the
 * router's `server.validClientOrigins`, which is what Better Auth checks.
 */
export const CONSOLE_ORIGIN = 'http://localhost:4300';

/** $20, in micro-USD. Enough for thousands of mock generations. */
export const DEMO_TOP_UP_MICROS = 20_000_000;

export interface RouterStackOptions {
  /** Extra `CR_API_*` for the router process. */
  env?: Record<string, string>;
  /** Backend failures, keyed by the upstream model name. */
  backendFailures?: Record<string, UpstreamFailure>;
  /** Mirror the router's log to stderr — what `--verbose` gives the demo. */
  echoRouterLog?: boolean;
  /** Expose the evidence host's deny-path controls over HTTPS. */
  controlApi?: boolean;
  /** Sign this address in; each stack gets its own by default. */
  email?: string;
  /**
   * Bind the router here instead of on a free port. A browser-driven suite has
   * to tell the console where the API is before either process starts, so the
   * address cannot be discovered afterwards.
   */
  routerPort?: number;
  /** Origins allowed to call the API with credentials, beyond {@link CONSOLE_ORIGIN}. */
  extraClientOrigins?: string[];
}

export interface RouterStack {
  readonly backend: MockLiteLLM;
  readonly evidenceHost: MockEvidenceHost;
  readonly router: RouterProcess;
  readonly session: ConsoleSession;
  readonly credential: DemoCredential;
  /** `https://localhost:<port>` — the attested face of the router. */
  readonly upstreamUrl: string;
  /** File holding the root a gatekeeper has to trust. */
  readonly trustedRootFile: string;
  readonly balanceMicros: number;
  stop(): Promise<void>;
}

/** An unused TCP port, taken by binding one and letting go. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The router configuration the stack runs on: one endpoint, two models, the
 * mock backend, and the evidence host as the endpoint's publisher.
 */
export function demoRouterConfig(input: {
  litellmUrl: string;
  evidenceUrl: string;
  hostname: string;
  clientOrigins?: string[];
}): Record<string, unknown> {
  return {
    version: 1,
    server: {
      publicBaseUrl: 'http://127.0.0.1:0',
      validClientOrigins: [CONSOLE_ORIGIN, ...(input.clientOrigins ?? [])],
    },
    backends: { litellm: { baseUrl: input.litellmUrl } },
    endpoints: [
      {
        name: DEMO_ENDPOINT,
        hostname: input.hostname,
        tee: 'Intel TDX + H100 CC',
        evidenceUrl: input.evidenceUrl,
      },
    ],
    models: [
      {
        id: DEMO_MODEL,
        name: 'Llama 3.3 70B Instruct',
        litellmModel: DEMO_UPSTREAM_MODEL,
        endpoint: DEMO_ENDPOINT,
        contextLength: 131072,
        capabilities: ['chat', 'completions'],
        pricing: { promptPer1mMicros: 280000, completionPer1mMicros: 420000 },
      },
      {
        id: FAILING_MODEL,
        name: 'Llama 3.3 70B Instruct (broken backend)',
        litellmModel: FAILING_UPSTREAM_MODEL,
        endpoint: DEMO_ENDPOINT,
        contextLength: 131072,
        capabilities: ['chat'],
        pricing: { promptPer1mMicros: 280000, completionPer1mMicros: 420000 },
      },
    ],
    auth: { magicLink: { mailer: 'console', from: 'no-reply@confidential-router.local' } },
    evidence: { pollInterval: '2s' },
    log: { level: 'info', pretty: false },
    graphql: { path: '/graphql', introspection: true },
    swagger: { enabled: false },
  };
}

/**
 * Brings the whole left-hand side up and hands back live handles.
 *
 * Ordering is forced by what depends on what: the backend and the router's port
 * first, then the evidence host (which needs the router's address to front),
 * then the router (which needs the evidence URL and the host's root in its trust
 * store to poll it over TLS).
 */
export async function startRouterStack(options: RouterStackOptions = {}): Promise<RouterStack> {
  const directory = mkdtempSync(join(tmpdir(), 'cr-stack-'));
  const started: (() => Promise<void>)[] = [];
  const unwind = async (): Promise<void> => {
    for (const stop of started.reverse()) {
      await stop().catch(() => undefined);
    }
    rmSync(directory, { recursive: true, force: true });
  };

  try {
    const backend = await startMockLiteLLM({ failures: options.backendFailures });
    started.push(() => backend.close());

    const routerPort = options.routerPort ?? (await freePort());
    const evidenceHost = await startMockEvidenceHost({
      upstream: `http://127.0.0.1:${routerPort}`,
      controlApi: options.controlApi,
    });
    started.push(() => evidenceHost.close());

    const trustedRootFile = join(directory, 'mock-cloud-root.pem');
    writeFileSync(trustedRootFile, evidenceHost.trustedRootPem, 'utf8');

    const router = await startRouterProcess({
      port: routerPort,
      extraCaFile: trustedRootFile,
      echoLog: options.echoRouterLog,
      env: {
        CR_API_SERVER__PUBLIC_BASE_URL: `http://127.0.0.1:${routerPort}`,
        CR_API_AUTH__BASE_URL: `http://127.0.0.1:${routerPort}`,
        ...options.env,
      },
      config: demoRouterConfig({
        litellmUrl: backend.url,
        hostname: evidenceHost.hostname,
        evidenceUrl: `${evidenceHost.url}${EVIDENCE_PATH_SUFFIX}`,
        clientOrigins: options.extraClientOrigins,
      }),
    });
    started.push(() => router.stop());

    const email = options.email ?? `demo-${Date.now().toString(36)}@confidential-router.local`;
    const session = await signIn(router, email, CONSOLE_ORIGIN);
    const balanceMicros = await topUp(session, DEMO_TOP_UP_MICROS);
    const credential = await createApiKey(session, 'Demo key');

    return {
      backend,
      evidenceHost,
      router,
      session,
      credential,
      upstreamUrl: evidenceHost.url,
      trustedRootFile,
      balanceMicros,
      stop: unwind,
    };
  } catch (error) {
    await unwind();
    throw error;
  }
}
