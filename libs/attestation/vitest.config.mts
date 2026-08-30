import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  test: {
    name: '@confidential-router/attestation',
    environment: 'node',
    globals: true,
    passWithNoTests: false,
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    // The bundle-size budget runs a real Vite browser build of the package; on a
    // cold Nx cache that is the slowest thing in the suite.
    testTimeout: 120_000,
    coverage: {
      reportsDirectory: '../../test-output/vitest/coverage/attestation',
    },
  },
});
