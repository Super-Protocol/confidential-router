/**
 * The dependencies the webpack build leaves *outside* the bundle, and the
 * manifest a container image installs to satisfy them.
 *
 * `better-sqlite3` ships a compiled `.node` addon that `bindings` locates by
 * walking up from the calling file. Bundled, that walk starts in `dist/` and
 * finds nothing — so it stays external and is required from `node_modules` at
 * runtime. `auth.options.ts` imports it at module scope whatever the configured
 * database is, so it is not optional: a runtime image without it dies on the
 * first import, not on the first SQLite query.
 *
 * Two consumers have to agree on that list — `webpack.config.js`, which marks
 * the packages external, and `router-api.dockerfile`, which installs them into
 * the runtime stage. A disagreement is a container that builds green and then
 * fails to boot, so there is one list, and it lives here.
 *
 * Run as a script, this writes a `package.json` holding exactly those
 * dependencies at the versions *this workspace resolved*, so the image matches
 * the lockfile rather than whatever a semver range means on the build day:
 *
 *   node apps/router-api/tools/runtime-deps.cjs /runtime/package.json
 */
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');

/** Packages webpack must not bundle, and the runtime image must install. */
const EXTERNAL_AT_RUNTIME = ['better-sqlite3'];

/** Version of an installed package, read from its own manifest. */
function installedVersion(name) {
  return require(`${name}/package.json`).version;
}

/**
 * The `package.json` of the runtime `node_modules` — exact versions, no ranges,
 * so `npm install` in the image cannot resolve something the workspace never
 * tested against.
 */
function runtimeManifest(resolveVersion = installedVersion) {
  const dependencies = {};
  for (const name of EXTERNAL_AT_RUNTIME) {
    dependencies[name] = resolveVersion(name);
  }
  return { name: 'router-api-runtime', version: '0.0.0', private: true, dependencies };
}

module.exports = { EXTERNAL_AT_RUNTIME, runtimeManifest };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node runtime-deps.cjs <path/to/package.json>');
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(runtimeManifest(), null, 2)}\n`);
  console.log(`[runtime-deps] wrote ${target}: ${EXTERNAL_AT_RUNTIME.join(', ')}`);
}
