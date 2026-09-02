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
  workspaceId: string;
  email: string;
  apiKeySecret: string;
  apiKeyId: string;
  evidenceDigest: string;
  endpointHostname: string;
  evidenceHostUrl: string;
  trustedRootFile: string;
  balanceMicros: number;
}

export function readHandoff(): StackHandoff {
  try {
    return JSON.parse(readFileSync(HANDOFF_FILE, 'utf8')) as StackHandoff;
  } catch (error) {
    throw new Error(
      `no live stack at ${HANDOFF_FILE} — the cross-app project needs tools/demo/src/serve.ts running ` +
        `(Playwright starts it as a webServer): ${(error as Error).message}`,
    );
  }
}

/**
 * Puts the browser in the state a completed magic-link sign-in leaves it in.
 *
 * The session cookie belongs to the API's host and the routing marker to the
 * console's — the split a real deployment has, and the one this suite now
 * serves (`origins.ts`).
 */
export async function useSession(page: Page, baseURL: string, handoff: StackHandoff): Promise<void> {
  const [name, value] = handoff.sessionCookie.split('=');
  if (name !== SESSION_COOKIE_NAME) {
    throw new Error(`the handoff carries a "${name}" cookie, expected ${SESSION_COOKIE_NAME}`);
  }
  await page.context().addCookies([
    { name, value, url: handoff.apiOrigin },
    { name: SIGNED_IN_COOKIE_NAME, value: '1', url: baseURL },
  ]);
}
