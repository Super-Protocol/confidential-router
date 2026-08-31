import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(rootDir));

/**
 * Named `vitest.e2e.config.mts` rather than `vitest.config.mts` on purpose: the
 * `@nx/vitest` plugin infers a `test` target from the latter, and this suite is
 * not a unit suite. It spawns processes, binds ports and takes seconds per
 * case, so it belongs to `e2e` — the target CI runs deliberately.
 */
export default defineConfig({
  root: rootDir,
  resolve: {
    // Run the tools from source; a suite held to a stale `dist/` proves less
    // than nothing.
    conditions: ['@confidential-router/source'],
    alias: [
      { find: /^@confidential-router\/demo$/, replacement: `${repoRoot}/tools/demo/src/index.ts` },
      {
        find: /^@confidential-router\/mock-evidence-host$/,
        replacement: `${repoRoot}/tools/mock-evidence-host/src/index.ts`,
      },
      { find: /^@confidential-router\/mock-litellm$/, replacement: `${repoRoot}/tools/mock-litellm/src/index.ts` },
      {
        find: /^@confidential-router\/attestation-fixtures$/,
        replacement: `${repoRoot}/libs/attestation-fixtures/src/index.ts`,
      },
    ],
  },
  test: {
    name: '@confidential-router/router-api-e2e',
    environment: 'node',
    globals: true,
    include: ['src/**/*.e2e.spec.ts'],
    // One router process per file, shared by every case in it. Files still run
    // in separate workers, so two suites never contend for the same port.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
    coverage: {
      reportsDirectory: '../../test-output/vitest/coverage/router-api-e2e',
    },
  },
});
