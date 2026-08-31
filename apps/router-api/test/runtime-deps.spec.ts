import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `tools/runtime-deps.cjs` is the one list of packages webpack leaves external
 * and `router-api.dockerfile` installs. Nothing else in the build fails when it
 * is wrong — the image builds green and then dies on its first import — so the
 * checks it cannot make about itself are made here.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { EXTERNAL_AT_RUNTIME, runtimeManifest } = require_('../tools/runtime-deps.cjs') as {
  EXTERNAL_AT_RUNTIME: string[];
  runtimeManifest: (resolveVersion?: (name: string) => string) => {
    name: string;
    private: boolean;
    dependencies: Record<string, string>;
  };
};

describe('runtime-deps', () => {
  /**
   * Read as text rather than required: `webpack.config.js` instantiates
   * `NxAppWebpackPlugin`, which only constructs inside an Nx build. What matters
   * is that the file takes its external list from here instead of declaring one.
   */
  it('is the list webpack marks external', () => {
    const config = readFileSync(join(HERE, '..', 'webpack.config.js'), 'utf8');

    expect(config).toContain("require('./tools/runtime-deps.cjs')");
    expect(config).toContain('externalDependencies: EXTERNAL_AT_RUNTIME');
  });

  /** The other half of the contract: the image installs what webpack excluded. */
  it('is what the runtime image installs', () => {
    const dockerfile = readFileSync(join(HERE, '..', '..', '..', 'router-api.dockerfile'), 'utf8');

    expect(dockerfile).toContain('apps/router-api/tools/runtime-deps.cjs');
  });

  it('lists every external as a dependency of the runtime image', () => {
    expect(Object.keys(runtimeManifest(() => '1.2.3').dependencies)).toEqual(EXTERNAL_AT_RUNTIME);
  });

  /**
   * A range would let the image resolve a version the workspace never installed
   * — for a package that compiles a native addon, that is a different binary
   * from the one CI tested.
   */
  it('pins exact versions, resolved from what this workspace installed', () => {
    const { dependencies } = runtimeManifest();

    for (const name of EXTERNAL_AT_RUNTIME) {
      const installed = (require_(`${name}/package.json`) as { version: string }).version;
      expect(dependencies[name]).toBe(installed);
      expect(dependencies[name]).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  /** `better-sqlite3` is imported at module scope by `auth/auth.options.ts`. */
  it('includes better-sqlite3, which the process imports whatever the database is', () => {
    expect(EXTERNAL_AT_RUNTIME).toContain('better-sqlite3');
  });
});
