/**
 * The live stack a cross-app spec runs against.
 *
 * Every other spec in this project mocks GraphQL: a screen test should fail
 * because the screen is wrong, not because a database is. These flows are the
 * complement — the console against the real router-api, over real HTTP, with a
 * real session — and they exist to catch what mocking cannot: a query the API
 * no longer answers the way the screen expects, a cookie that does not travel,
 * a key the console minted that the gateway will not accept.
 *
 * `tools/demo/src/serve.ts` starts the stack (Playwright's second `webServer`)
 * and leaves the details a browser cannot discover in a handoff file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { SESSION_COOKIE_NAME, SIGNED_IN_COOKIE_NAME } from './fixtures';

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDOFF_FILE = join(HERE, '..', '..', '..', 'test-output', 'demo-stack.json');

export interface StackHandoff {
  apiBaseUrl: string;
  apiOrigin: string;
  consoleOrigin: string;
  sessionCookie: string;
  /** The operator in `auth.adminEmails`; deliberately not {@link email}. */
  adminSessionCookie: string;
  adminEmail: string;
  workspaceId: string;
  email: string;
  apiKeySecret: string;
  apiKeyId: string;
  evidenceDigest: string;
  endpointHostname: string;
  evidenceHostUrl: string;
  trustedRootFile: string;
  balanceMicros: number;
  /** Present only when the stack was started with `CR_DEMO_EXTERNAL=1`. */
  external?: ExternalHandoff;
}

/** A registered, admitted and already-inspectable upstream (ADR-008). */
export interface ExternalHandoff {
  endpointName: string;
  hostname: string;
  upstreamUrl: string;
  modelId: string;
  modelName: string;
  /** `ExternalEndpoint.evidenceDigestSeen` — the key the relay answers on. */
  evidenceDigest: string;
  measurement: string;
  adminEmail: string;
}

/**
 * How long the handoff may lag the port it was probed through.
 *
 * Playwright holds the tests until `webServer.url` answers, and for this stack
 * that probe is the router's `/health` — which is true as soon as the process is
 * up and therefore *before* `serve.ts` has signed anyone in, bought any credit,
 * or (with `CR_DEMO_EXTERNAL=1`) registered and verified an upstream. There is
 * no URL that becomes true at the end of all that, so the file is what we wait
 * on. The window used to be a second and nobody noticed; it is now as long as an
 * attestation takes.
 */
const HANDOFF_TIMEOUT_MS = 120_000;

/**
 * The live stack's handoff, waiting for `serve.ts` to finish writing it.
 *
 * `serve.ts` deletes a stale file before it starts anything, so what this waits
 * for is always this run's.
 */
export async function readHandoff(): Promise<StackHandoff> {
  const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
  let last = '';
  for (;;) {
    try {
      return JSON.parse(readFileSync(HANDOFF_FILE, 'utf8')) as StackHandoff;
    } catch (error) {
      last = (error as Error).message;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no live stack at ${HANDOFF_FILE} after ${HANDOFF_TIMEOUT_MS}ms — this project needs ` +
          `tools/demo/src/serve.ts running (Playwright starts it as a webServer): ${last}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The upstream, or a failure that says which stack is missing it.
 *
 * `external` is optional on the handoff because only one Playwright project
 * starts a stack that has one. A spec that needs it should fail here, naming the
 * flag, rather than on a selector that found nothing.
 */
export function requireExternal(handoff: StackHandoff): ExternalHandoff {
  if (!handoff.external) {
    throw new Error(
      'this stack has no external upstream — tools/demo/src/serve.ts needs CR_DEMO_EXTERNAL=1 ' +
        '(playwright.secure.config.ts sets it)',
    );
  }
  return handoff.external;
}

/**
 * Puts the browser in the state a completed magic-link sign-in leaves it in.
 *
 * The session cookie belongs to the API's host and the routing marker to the
 * console's — the split a real deployment has, and the one this suite now
 * serves (`origins.ts`).
 */
export async function useSession(page: Page, baseURL: string, handoff: StackHandoff): Promise<void> {
  await useCookie(page, baseURL, { cookie: handoff.sessionCookie, apiOrigin: handoff.apiOrigin });
}

/** The same, as the stack's operator — the one in `auth.adminEmails` (SUP-268). */
export async function useAdminSession(page: Page, baseURL: string, handoff: StackHandoff): Promise<void> {
  await useCookie(page, baseURL, { cookie: handoff.adminSessionCookie, apiOrigin: handoff.apiOrigin });
}

async function useCookie(
  page: Page,
  baseURL: string,
  { cookie, apiOrigin }: { cookie: string; apiOrigin: string },
): Promise<void> {
  const [name, value] = cookie.split('=');
  if (name !== SESSION_COOKIE_NAME) {
    throw new Error(`the handoff carries a "${name}" cookie, expected ${SESSION_COOKIE_NAME}`);
  }
  await page.context().addCookies([
    { name, value, url: apiOrigin },
    { name: SIGNED_IN_COOKIE_NAME, value: '1', url: baseURL },
  ]);
}
