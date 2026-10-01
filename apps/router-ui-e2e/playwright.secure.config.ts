import { defineConfig, devices } from '@playwright/test';

/**
 * The one suite that runs the console on a **secure context**, against the live
 * stack — and therefore the only place tier 1 is exercised at all.
 *
 * `playwright.config.ts` serves `console.localtest.me:4300` on purpose, so that
 * cookie behaviour matches a deployment (`src/origins.ts`, SUP-113). The price is
 * stated there: a named http origin is not a secure context, browsers withhold
 * `crypto.subtle` from one, and the console's evidence gate is Web Crypto from
 * end to end. So on that origin the chat can only ever show its refusal, and
 * everything past "the browser could not look" — fetching a real bundle, checking
 * a real chain, verifying a real JWS, drawing the graph out of the payload that
 * verified — has no browser to be proven in.
 *
 * This config pays the opposite price. Both the console and the API sit on
 * `127.0.0.1`, which browsers treat as trustworthy, so Web Crypto is there and
 * tier 1 runs for real against the bundle `tools/mock-evidence-host` signs. The
 * cookie isolation is given up — and nothing here asserts anything about
 * cookies: `useSession` installs the handoff cookie directly, and every
 * assertion is about attestation. The suite that *does* care about cookies is
 * the other one, unchanged.
 *
 * A separate config and a separate `e2e-secure` target, for the same reason
 * `playwright.image.config.ts` is separate: it needs its own servers on its own
 * origins, and folding it into the main config would impose them on every spec.
 *
 *   pnpm nx run @confidential-router/router-ui-e2e:e2e-secure
 */

/** Deliberately not 4300/3000: this stack is a second one, not a replacement. */
const CONSOLE_PORT = Number(process.env.ROUTER_UI_SECURE_PORT ?? 4310);
const API_PORT = Number(process.env.ROUTER_API_SECURE_PORT ?? 3010);

/** Loopback literal rather than `localhost`, which glibc may resolve to `::1`. */
const CONSOLE_ORIGIN = `http://127.0.0.1:${CONSOLE_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  testDir: './src',
  testMatch: 'secure-origin.spec.ts',
  outputDir: '../../test-output/playwright/router-ui-secure',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One stack, one workspace, one evidence host whose published snapshot the
  // suite deliberately rotates — parallel workers would rotate it under each other.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: CONSOLE_ORIGIN,
    viewport: { width: 1600, height: 1200 },
    trace: 'retain-on-failure',
    video: process.env.PLAYWRIGHT_VIDEO === 'on' ? 'on' : 'retain-on-failure',
  },
  projects: [{ name: 'secure-origin', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm exec next start --port ${CONSOLE_PORT} --hostname 127.0.0.1`,
      cwd: new URL('../router-ui', import.meta.url).pathname,
      env: { ROUTER_UI_API_ORIGIN: API_ORIGIN },
      url: CONSOLE_ORIGIN,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // router-api, mock-litellm and the mock evidence host, behind one command.
      command: 'pnpm exec tsx tools/demo/src/serve.ts',
      cwd: new URL('../..', import.meta.url).pathname,
      env: {
        NODE_OPTIONS: '--conditions=@confidential-router/source',
        ROUTER_UI_BASE_URL: CONSOLE_ORIGIN,
        ROUTER_API_E2E_ORIGIN: API_ORIGIN,
        ROUTER_API_E2E_PORT: String(API_PORT),
      },
      url: `${API_ORIGIN}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
