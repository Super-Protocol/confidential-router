const { join } = require('node:path');
const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { IgnorePlugin } = require('webpack');
// Shared with `router-api.dockerfile`, which installs exactly this list into the
// runtime image. See the file for why the two must not drift.
const { EXTERNAL_AT_RUNTIME } = require('./tools/runtime-deps.cjs');

/**
 * TypeORM, Nest and Apollo all reference drivers and adapters they support but
 * that this service does not install — every database driver TypeORM knows, the
 * Fastify and federation halves of Apollo, the microservices transport.
 *
 * They are loaded behind `try { require(…) }`, so stubbing them out here keeps
 * webpack from failing the build while leaving the runtime behaviour intact: a
 * request for one still raises "cannot find module", which is what those
 * `try` blocks are written to handle.
 */
const OPTIONAL_AT_RUNTIME = [
  '@apollo/gateway',
  '@apollo/subgraph',
  '@as-integrations/fastify',
  '@google-cloud/spanner',
  '@nestjs/microservices',
  '@nestjs/websockets',
  '@opentelemetry/api',
  '@sap/hana-client',
  'bufferutil',
  'class-transformer/storage',
  'hdb-pool',
  'ioredis',
  'mongodb',
  'mssql',
  'mysql',
  'mysql2',
  'oracledb',
  'pg-native',
  'pg-query-stream',
  'react-native-sqlite-storage',
  'redis',
  'sql.js',
  'sqlite3',
  'ts-morph',
  'typeorm-aurora-data-api-driver',
  'utf-8-validate',
];

module.exports = {
  output: {
    path: join(__dirname, 'dist'),
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new IgnorePlugin({
      checkResource: (resource) =>
        OPTIONAL_AT_RUNTIME.some((name) => resource === name || resource.startsWith(`${name}/`)),
    }),
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      externalDependencies: EXTERNAL_AT_RUNTIME,
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      // Object form (not './conf'): Nx only accepts string assets under the
      // project source root, and the config file belongs next to the app.
      assets: [{ input: 'apps/router-api/conf', glob: '**/*', output: 'conf' }],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: true,
      sourceMaps: true,
      additionalEntryPoints: [
        {
          entryName: 'cli/run-migrations',
          entryPath: './src/cli/run-migrations.ts',
        },
      ],
    }),
  ],
};
