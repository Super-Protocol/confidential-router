import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(rootDir));

export default defineConfig({
  root: rootDir,
  resolve: {
    conditions: ['@confidential-router/source'],
    alias: {
      '@confidential-router/server-common': `${repoRoot}/libs/server-common/src/index.ts`,
    },
  },
  plugins: [
    // NestJS and TypeORM both read `design:type` metadata, which esbuild — the
    // default transformer — does not emit. swc does.
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
      module: { type: 'es6' },
      sourceMaps: true,
    }),
  ],
  esbuild: false,
  test: {
    name: '@confidential-router/router-api',
    environment: 'node',
    globals: true,
    passWithNoTests: false,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    coverage: {
      reportsDirectory: '../../test-output/vitest/coverage/router-api',
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The e2e suites each own a database file; running them in parallel in one
    // process is fine, across processes it is not worth the flakiness.
    maxWorkers: 1,
    fileParallelism: false,
  },
});
