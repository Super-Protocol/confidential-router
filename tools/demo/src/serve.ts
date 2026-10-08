/**
 * The stack as a long-lived server, for a browser-driven suite.
 *
 *   tsx tools/demo/src/serve.ts
 *
 * Playwright starts this as a `webServer` and stops it afterwards. It differs
 * from the demo in exactly one way that matters: the router binds a *fixed*
 * port, because the console has to be handed that origin when Playwright builds
 * its `webServer` commands — before this process exists to be asked.
 *
 * Whatever a test cannot discover over HTTP — the session cookie, the workspace
 * id, the plaintext key — is written to a handoff file, because the alternative
 * is making the browser sign in through a magic link it would have to read out
 * of a log.
 *
 * `CR_DEMO_EXTERNAL=1` additionally stands up a model endpoint in *another*
 * deployment and registers it: the upstream, the real egress sidecar that
 * attests it, and an admitted, inspectable external model (ADR-008). It is a
 * flag rather than the default because it costs two more processes and puts a
 * second model in `/v1/models` and in the chat picker — and only the suite that
 * runs the browser on a secure context has anything to do with it
 * (`playwright.secure.config.ts`). Every other suite's stack stays as it was.
 */
import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  addTrustedMeasurement,
  type ExternalStand,
  registerExternalEndpoint,
  STAND_MEASUREMENT,
  startExternalStand,
  waitForExternalStatus,
  waitForRelayedBundle,
} from './external-stand.js';
import { type ExternalHandoff, HANDOFF_FILE, type StackHandoff, TRUSTED_ROOT_FILE } from './handoff.js';
import { type RouterStack, type RouterStackOptions, startRouterStack } from './stack.js';

/** Where the console is served from in `apps/router-ui-e2e/playwright.config.ts`. */
const CONSOLE_E2E_ORIGIN = process.env.ROUTER_UI_BASE_URL ?? 'http://127.0.0.1:4300';
/** What `playwright.config.ts` points the console at, and therefore where the API must be. */
const ROUTER_PORT = Number(process.env.ROUTER_API_E2E_PORT ?? 3000);
/**
 * The API's *browser-facing* origin: the same process, under a different
 * hostname from the console's, so the browser keeps the two sets of cookies
 * apart exactly as a deployment does (`apps/router-ui-e2e/src/origins.ts`).
 *
 * Only the browser uses this name. The router's own `baseUrl` stays on loopback
 * because everything here reaches it from Node — the magic link out of the log,
 * the checkout redirect — and glibc resolves `*.localhost` to `::1`, where
 * nothing is listening.
 */
const API_E2E_ORIGIN = process.env.ROUTER_API_E2E_ORIGIN ?? `http://127.0.0.1:${ROUTER_PORT}`;

/*
 * A stale handoff is deleted before anything starts, not only on the way out.
 *
 * The file is what a browser-driven suite waits on, because Playwright's own
 * readiness probe is the router's `/health` and that is true well before this
 * script has finished signing anyone in. A leftover file from a crashed run
 * would satisfy that wait instantly, with every value in it wrong.
 */
rmSync(HANDOFF_FILE, { force: true });

/** Whether to stand up an external upstream beside the router (ADR-008). */
const WITH_EXTERNAL = process.env.CR_DEMO_EXTERNAL === '1';

/** The browser's session. An ordinary member, and deliberately not an admin. */
const SESSION_EMAIL = 'console-e2e@confidential-router.local';
/**
 * The operator who registers the upstream — a different person.
 *
 * Ruling 3 on SUP-221 opened the external-endpoint reads, and the relay they
 * rest on, to *any* signed-in member. A suite whose session happened to be in
 * `auth.adminEmails` would be unable to tell that apart from an admin-only
 * surface, so the stand keeps the two apart and the browser gets the weaker one.
 */
const ADMIN_EMAIL = 'console-e2e-admin@confidential-router.local';

const EXTERNAL_ENDPOINT = 'partner-cloud';
const EXTERNAL_MODEL_ID = 'partner/llama-3.3-70b-instruct:snp';
const EXTERNAL_MODEL_NAME = 'Llama 3.3 70B Instruct (partner cloud)';
/** What the upstream calls the model; `tools/mock-litellm` answers for anything. */
const EXTERNAL_UPSTREAM_MODEL = 'vllm/llama-3.3-70b-instruct';
const EXTERNAL_UPSTREAM_KEY = 'sk-demo-partner-cloud-key';

const stackOptions: RouterStackOptions = {
  routerPort: ROUTER_PORT,
  extraClientOrigins: [CONSOLE_E2E_ORIGIN],
  email: SESSION_EMAIL,
  // `docs/quickstart.md` drives the deny paths with curl against `/__mock/…`.
  controlApi: true,
  echoRouterLog: process.env.CR_DEMO_VERBOSE === '1',
};

let stand: ExternalStand | undefined;
let stack: RouterStack;
let external: ExternalHandoff | undefined;

if (WITH_EXTERNAL) {
  stand = await startExternalStand({ adminEmail: ADMIN_EMAIL, stack: { ...stackOptions } });
  stack = stand.stack;
  external = await registerUpstream(stand);
} else {
  stack = await startRouterStack({ ...stackOptions });
}

/**
 * Registers the upstream and waits until a browser could actually inspect it.
 *
 * Three waits, in the order the product imposes them, and none of them skippable:
 * the sidecar has nothing to supervise until an endpoint is rendered, no verdict
 * until the measurement is listed, and nothing to relay until the evidence
 * poller has fetched the publication that verdict named.
 */
async function registerUpstream(ready: ExternalStand): Promise<ExternalHandoff> {
  /*
   * Move the upstream off the fixture snapshot before anything verifies it.
   *
   * Both mock evidence hosts publish the same conformance vector by default, so
   * out of the box this router's own digest and the upstream's are the same
   * string — and a panel asserted against that could be reading either document
   * and look right. One deterministic redeployment makes the two provably
   * different, which is what turns "the digest on screen is the upstream's"
   * into a claim with content.
   */
  const upstreamDigest = await ready.upstream.evidenceHost.rotateDeployment('external-stand');
  if (upstreamDigest === ready.stack.evidenceHost.evidenceDigest()) {
    throw new Error('the upstream and this router publish the same digest, so nothing could tell them apart');
  }

  const registered = await registerExternalEndpoint(ready.admin, {
    name: EXTERNAL_ENDPOINT,
    baseUrl: ready.upstream.url,
    apiKey: EXTERNAL_UPSTREAM_KEY,
    models: [{ id: EXTERNAL_MODEL_ID, name: EXTERNAL_MODEL_NAME, upstreamModel: EXTERNAL_UPSTREAM_MODEL }],
  });
  await addTrustedMeasurement(ready.admin, STAND_MEASUREMENT, 'the partner cloud');
  await ready.sidecar.waitUntilStarted();
  const verified = await waitForExternalStatus(ready.admin, registered.id, ['VERIFIED_BY_THIS_ROUTER']);
  await waitForRelayedBundle(ready.stack.router.baseUrl, EXTERNAL_ENDPOINT);

  if (!verified.evidenceDigestSeen || !verified.measurementSeen) {
    throw new Error(
      `the verdict for "${EXTERNAL_ENDPOINT}" named no digest or measurement, so there is nothing to inspect`,
    );
  }
  if (verified.evidenceDigestSeen !== upstreamDigest) {
    // The verdict ran against a publication the upstream has since replaced,
    // which would leave the relay keyed on a digest no reader here expects.
    throw new Error(`the verdict saw ${verified.evidenceDigestSeen} but the upstream publishes ${upstreamDigest}`);
  }
  return {
    endpointName: registered.name,
    hostname: verified.hostname,
    upstreamUrl: ready.upstream.url,
    modelId: EXTERNAL_MODEL_ID,
    modelName: EXTERNAL_MODEL_NAME,
    evidenceDigest: verified.evidenceDigestSeen,
    measurement: verified.measurementSeen,
    adminEmail: ADMIN_EMAIL,
  };
}

const handoff: StackHandoff = {
  apiBaseUrl: stack.router.baseUrl,
  apiOrigin: API_E2E_ORIGIN,
  consoleOrigin: CONSOLE_E2E_ORIGIN,
  sessionCookie: stack.session.cookie,
  workspaceId: stack.session.workspaceId,
  email: stack.session.email,
  apiKeySecret: stack.credential.secret,
  apiKeyId: stack.credential.id,
  evidenceDigest: stack.evidenceHost.evidenceDigest(),
  endpointHostname: stack.evidenceHost.hostname,
  evidenceHostUrl: stack.evidenceHost.url,
  trustedRootFile: TRUSTED_ROOT_FILE,
  balanceMicros: stack.balanceMicros,
  ...(external ? { external } : {}),
};

mkdirSync(dirname(HANDOFF_FILE), { recursive: true });
copyFileSync(stack.trustedRootFile, TRUSTED_ROOT_FILE);
/*
 * Temporary file and rename, because the reader is another process polling for
 * this file to appear: a plain write is briefly observable as half a document,
 * and a torn read on a waiter's last attempt would fail a suite for no reason.
 */
writeFileSync(`${HANDOFF_FILE}.tmp`, JSON.stringify(handoff, null, 2), 'utf8');
renameSync(`${HANDOFF_FILE}.tmp`, HANDOFF_FILE);

console.log(
  `[demo-stack] router-api    ${handoff.apiBaseUrl}   (browser ${API_E2E_ORIGIN}, console ${CONSOLE_E2E_ORIGIN})`,
);
console.log(`[demo-stack] evidence host ${handoff.evidenceHostUrl}   digest ${handoff.evidenceDigest}`);
console.log(`[demo-stack] trusted root  ${TRUSTED_ROOT_FILE}`);
console.log(`[demo-stack] handoff       ${HANDOFF_FILE}`);
if (external) {
  console.log(`[demo-stack] upstream      ${external.upstreamUrl}   endpoint ${external.endpointName}`);
  console.log(`[demo-stack] upstream model ${external.modelId}   digest ${external.evidenceDigest}`);
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) {
      return;
    }
    stopping = true;
    rmSync(HANDOFF_FILE, { force: true });
    rmSync(TRUSTED_ROOT_FILE, { force: true });
    // The stand owns the router stack when there is one, and stopping it stops
    // the upstream and the sidecar with it.
    void (stand ?? stack).stop().then(() => process.exit(0));
  });
}
