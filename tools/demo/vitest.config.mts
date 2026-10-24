import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(rootDir));

export default defineConfig({
  root: rootDir,
  // The same source resolution the e2e suite that drives this stand uses: the
  // stand's own module pulls in the mocks it assembles, and those publish their
  // `dist/` by default — which this target never builds. An alias per package
  // reached, because the `conditions` do not reach a bare import made from
  // inside an aliased one.
  resolve: {
    conditions: ['@confidential-router/source'],
    alias: [
      {
        find: /^@confidential-router\/mock-evidence-host$/,
        replacement: `${repoRoot}/tools/mock-evidence-host/src/index.ts`,
      },
      { find: /^@confidential-router\/mock-litellm$/, replacement: `${repoRoot}/tools/mock-litellm/src/index.ts` },
      {
        find: /^@confidential-router\/attestation-fixtures$/,
        replacement: `${repoRoot}/libs/attestation-fixtures/src/index.ts`,
      },
      { find: /^@confidential-router\/types$/, replacement: `${repoRoot}/libs/types/src/index.ts` },
    ],
  },
  test: {
    name: '@confidential-router/demo',
    environment: 'node',
    globals: true,
    passWithNoTests: true,
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    coverage: {
      reportsDirectory: '../../test-output/vitest/coverage/demo',
    },
  },
});
