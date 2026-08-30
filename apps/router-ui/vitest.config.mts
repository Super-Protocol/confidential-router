import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  // esbuild's automatic JSX runtime is all these tests need; the React plugin
  // exists for Fast Refresh, which vitest does not use.
  esbuild: { jsx: 'automatic' },
  test: {
    name: '@confidential-router/router-ui',
    environment: 'jsdom',
    globals: true,
    passWithNoTests: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'specs/**/*.spec.tsx'],
    coverage: {
      reportsDirectory: '../../test-output/vitest/coverage/router-ui',
    },
  },
});
