import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.ROUTER_UI_PORT ?? 4300);
const BASE_URL = process.env.ROUTER_UI_BASE_URL ?? `http://127.0.0.1:${PORT}`;

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
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next start --port ${PORT} --hostname 127.0.0.1`,
    cwd: new URL('../router-ui', import.meta.url).pathname,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
