import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.ROUTER_UI_PORT ?? 4300);
const BASE_URL = process.env.ROUTER_UI_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * Where the router binds, and what the console is pointed at.
 *
 * The console takes its API origin from the environment now (SUP-100), so this
 * is one value read twice below rather than a build-time binding. It is still a
 * fixed port and not a free one: both `webServer` commands are built when this
 * file loads, before either process exists to be asked what it got.
 */
const API_PORT = Number(process.env.ROUTER_API_E2E_PORT ?? 3000);
const API_URL = `http://127.0.0.1:${API_PORT}`;

/** `cross-app` runs against a live stack; every other spec here mocks the API. */
const CROSS_APP = 'cross-app.spec.ts';

/** Owned by `playwright.image.config.ts`: it needs Docker and a built image. */
const IMAGE_ORIGINS = 'image-origins.spec.ts';

/**
 * The suite runs against a production build rather than `next dev`: the proxy
 * (session redirects) and route-group layouts behave the same either way, but a
 * dev server recompiles on first hit and turns a smoke test into a flake.
 * `@confidential-router/router-ui-e2e:e2e` depends on the app's `build` target.
 */
export default defineConfig({
  testDir: './src',
  outputDir: '../../test-output/playwright/router-ui',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    // A failure keeps its video; `PLAYWRIGHT_VIDEO=on` records every test, which
    // is how the console flows get recorded for a review (Team Workflow §4)
    // without editing this file.
    video: process.env.PLAYWRIGHT_VIDEO === 'on' ? 'on' : 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [CROSS_APP, IMAGE_ORIGINS],
    },
    {
      // Serial, and after the mocked project: it shares one router-api process
      // and one workspace across its cases, so parallel workers would fight
      // over the same ledger.
      name: 'cross-app',
      use: { ...devices['Desktop Chrome'] },
      testMatch: CROSS_APP,
      fullyParallel: false,
      workers: 1,
    },
  ],
  webServer: [
    {
      command: `pnpm exec next start --port ${PORT} --hostname 127.0.0.1`,
      cwd: new URL('../router-ui', import.meta.url).pathname,
      env: { ROUTER_UI_API_ORIGIN: API_URL },
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // router-api, mock-litellm and the mock evidence host, behind one command.
      command: 'pnpm exec tsx tools/demo/src/serve.ts',
      cwd: new URL('../..', import.meta.url).pathname,
      env: { NODE_OPTIONS: '--conditions=@confidential-router/source' },
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
