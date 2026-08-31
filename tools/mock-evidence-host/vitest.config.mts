import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(rootDir));

export default defineConfig({
  root: rootDir,
  // The suite runs the *sources* of the verifier and the fixtures, not their
  // build output: a mock held to a stale `dist/` would stop being evidence of
  // anything the day the verifier changes.
  resolve: {
    conditions: ['@confidential-router/source'],
    alias: [
      { find: /^@confidential-router\/attestation$/, replacement: `${repoRoot}/libs/attestation/src/index.ts` },
      {
        find: /^@confidential-router\/attestation-fixtures$/,
        replacement: `${repoRoot}/libs/attestation-fixtures/src/index.ts`,
      },
    ],
  },
  test: {
    name: '@confidential-router/mock-evidence-host',
    environment: 'node',
    globals: true,
    passWithNoTests: true,
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    coverage: {
      reportsDirectory: '../../test-output/vitest/coverage/mock-evidence-host',
    },
  },
});
