import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  test: {
    name: '@confidential-router/attestation-fixtures',
    environment: 'node',
    globals: true,
    passWithNoTests: false,
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    coverage: {
      reportsDirectory: '../../test-output/vitest/coverage/attestation-fixtures',
    },
  },
});
