/**
 * The acceptance test for runtime public configuration (SUP-100): the *image*,
 * run twice with different `ROUTER_UI_API_ORIGIN`, and a browser that has to
 * call each one.
 *
 * It is a separate config, and a separate `e2e-image` target, because it is the
 * one suite here that needs Docker and a built image. `nx affected -t e2e` runs
 * the other config; CI runs this one in the job that builds the images.
 *
 *   make images
 *   pnpm nx run @confidential-router/router-ui-e2e:e2e-image
 */
import { defineConfig, devices } from '@playwright/test';
import { consoleUrl, DEPLOYMENTS, IMAGE } from './src/image-origins';

// Playwright stops the docker client on teardown and it forwards the signal, so
// `--rm` is normally enough; the `rm -f` first is for the run that was killed
// before it got there, which would otherwise leave the port held and every
// later run failing to start.
const container = (name: string, port: number, apiOrigin: string) =>
  `docker rm -f ${name} >/dev/null 2>&1; ` +
  `docker run --rm --name ${name} -e ROUTER_UI_API_ORIGIN=${apiOrigin} -p 127.0.0.1:${port}:3001 ${IMAGE}`;

export default defineConfig({
  testDir: './src',
  testMatch: 'image-origins.spec.ts',
  outputDir: '../../test-output/playwright/router-ui-image',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A container that failed to start will fail to start again; the retry would
  // only be noise on top of a clear error.
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: Object.entries(DEPLOYMENTS).map(([name, deployment]) => ({
    command: container(`router-ui-origin-${name}`, deployment.consolePort, deployment.apiOrigin),
    url: consoleUrl(deployment, '/login'),
    // Always a fresh container: reusing one from an earlier run would be
    // reusing its configuration, which is the thing under test.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  })),
});
