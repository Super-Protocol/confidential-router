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
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HANDOFF_FILE, type StackHandoff, TRUSTED_ROOT_FILE } from './handoff.js';
import { startRouterStack } from './stack.js';

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

const stack = await startRouterStack({
  routerPort: ROUTER_PORT,
  extraClientOrigins: [CONSOLE_E2E_ORIGIN],
  email: 'console-e2e@confidential-router.local',
  // `docs/quickstart.md` drives the deny paths with curl against `/__mock/…`.
  controlApi: true,
  echoRouterLog: process.env.CR_DEMO_VERBOSE === '1',
});

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
};

mkdirSync(dirname(HANDOFF_FILE), { recursive: true });
copyFileSync(stack.trustedRootFile, TRUSTED_ROOT_FILE);
writeFileSync(HANDOFF_FILE, JSON.stringify(handoff, null, 2), 'utf8');

console.log(
  `[demo-stack] router-api    ${handoff.apiBaseUrl}   (browser ${API_E2E_ORIGIN}, console ${CONSOLE_E2E_ORIGIN})`,
);
console.log(`[demo-stack] evidence host ${handoff.evidenceHostUrl}   digest ${handoff.evidenceDigest}`);
console.log(`[demo-stack] trusted root  ${TRUSTED_ROOT_FILE}`);
console.log(`[demo-stack] handoff       ${HANDOFF_FILE}`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) {
      return;
    }
    stopping = true;
    rmSync(HANDOFF_FILE, { force: true });
    rmSync(TRUSTED_ROOT_FILE, { force: true });
    void stack.stop().then(() => process.exit(0));
  });
}
