import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadRouterConfig, MissingAuthSecretError, resolveConfigFile, serviceVersion } from './config.js';
import { RouterConfigSchema } from './config.schema.js';

const SECRET = 'a'.repeat(32);
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..', '..');

let dir: string;
let configFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-router-config-'));
  configFile = join(dir, 'router.yaml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Points the loader at `configFile`, which the test may or may not create. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', CR_API_CONFIG_FILE: configFile, ...overrides };
}

describe('loadRouterConfig', () => {
  it('boots with no config file and no environment variables', () => {
    const config = loadRouterConfig({ env: env() });

    expect(config.database).toMatchObject({ type: 'sqlite', file: 'data/router-api.sqlite', migrationsRun: true });
    expect(config.server.port).toBe(3000);
    expect(config.endpoints).toEqual([]);
    expect(config.models).toEqual([]);
  });

  it('mints an ephemeral auth secret outside production and says so', () => {
    const warnings: string[] = [];
    const config = loadRouterConfig({ env: env(), onWarning: (message) => warnings.push(message) });

    expect(config.auth.secret).toHaveLength(64);
    expect(warnings.some((warning) => warning.includes('ephemeral'))).toBe(true);
  });

  it('refuses to boot in production without an auth secret', () => {
    expect(() => loadRouterConfig({ env: { NODE_ENV: 'production', CR_API_CONFIG_FILE: configFile } })).toThrow(
      MissingAuthSecretError,
    );
  });

  it('accepts a production auth secret from the environment', () => {
    const config = loadRouterConfig({
      env: {
        NODE_ENV: 'production',
        CR_API_CONFIG_FILE: configFile,
        CR_API_AUTH__SECRET: SECRET,
        CR_API_AUTH__BASE_URL: 'https://console.example',
      },
    });
    expect(config.auth.secret).toBe(SECRET);
  });

  it('does not overwrite a secret supplied by the config file', () => {
    writeFileSync(configFile, `auth:\n  secret: ${SECRET}\n`, 'utf8');
    const warnings: string[] = [];

    const config = loadRouterConfig({ env: env(), onWarning: (message) => warnings.push(message) });

    expect(config.auth.secret).toBe(SECRET);
    expect(warnings.some((warning) => warning.includes('ephemeral'))).toBe(false);
  });

  it('lets an environment variable override the config file', () => {
    writeFileSync(configFile, 'server:\n  port: 3000\n', 'utf8');

    const config = loadRouterConfig({ env: env({ CR_API_SERVER__PORT: '4321' }) });

    expect(config.server.port).toBe(4321);
  });

  it('expands ${VAR} placeholders in the config file', () => {
    writeFileSync(configFile, 'database:\n  type: postgres\n  url: ${CR_TEST_DB_URL}\n', 'utf8');

    const config = loadRouterConfig({ env: env({ CR_TEST_DB_URL: 'postgres://user@host/db' }) });

    expect(config.database).toMatchObject({ type: 'postgres', url: 'postgres://user@host/db' });
  });

  it('turns PostgreSQL migrate-on-boot off by default', () => {
    const config = loadRouterConfig({
      env: env({ CR_API_DATABASE__TYPE: 'postgres', CR_API_DATABASE__URL: 'postgres://user@host/db' }),
    });
    expect(config.database.migrationsRun).toBe(false);
  });

  it('parses durations into milliseconds', () => {
    writeFileSync(configFile, 'evidence:\n  pollInterval: 90s\n', 'utf8');

    const config = loadRouterConfig({ env: env() });

    expect(config.evidence.pollInterval).toBe(90_000);
    expect(config.evidence.freshnessWindow).toBe(86_400_000);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadRouterConfig({ env: env({ CR_API_SERVER__PORT: '70000' }) })).toThrow(/server\.port/);
  });

  it('ignores the CR_API_* meta-variables instead of mapping them into the config', () => {
    // `CR_API_VERSION` used to become `version: "1.2.3"` and collide with the
    // config's own `version: 1`, failing the boot on a variable that has
    // nothing to do with the schema. `CR_API_CONFIG_FILE` landed as `configFile`.
    const config = loadRouterConfig({
      env: env({ CR_API_VERSION: '1.2.3' }),
    });

    expect(config.version).toBe(1);
    expect(config).not.toHaveProperty('configFile');
  });

  it('rejects an unknown key rather than silently dropping it', () => {
    // The JSON Schema is `additionalProperties: false`; the runtime schema has
    // to agree, or `CR_API_SERVER__PROT=4000` leaves the port on its default.
    expect(() => loadRouterConfig({ env: env({ CR_API_SERVER__PROT: '4000' }) })).toThrow(/prot/i);
  });

  it('warns when no models are configured', () => {
    const warnings: string[] = [];
    loadRouterConfig({ env: env(), onWarning: (message) => warnings.push(message) });
    expect(warnings.some((warning) => warning.includes('No models'))).toBe(true);
  });
});

describe('serviceVersion', () => {
  it('reads CR_API_VERSION, which is deliberately not part of the config tree', () => {
    expect(serviceVersion({ CR_API_VERSION: '1.2.3' })).toBe('1.2.3');
  });

  it('falls back to 0.0.0 when unset', () => {
    expect(serviceVersion({})).toBe('0.0.0');
  });
});

describe('resolveConfigFile', () => {
  it('honours CR_API_CONFIG_FILE verbatim', () => {
    expect(resolveConfigFile({ CR_API_CONFIG_FILE: '/etc/router.yaml' }, [])).toBe('/etc/router.yaml');
  });

  it('prefers conf/router.yaml under the working directory', () => {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'router.yaml'), 'server: {}\n', 'utf8');

    expect(resolveConfigFile({}, ['node', '/opt/app/main.js'], dir)).toBe(join(dir, 'conf', 'router.yaml'));
  });

  it('falls back to conf/router.yaml beside the running bundle', () => {
    const bundleDir = join(dir, 'dist');
    mkdirSync(join(bundleDir, 'conf'), { recursive: true });
    writeFileSync(join(bundleDir, 'conf', 'router.yaml'), 'server: {}\n', 'utf8');

    // The working directory has no conf/router.yaml, so the second candidate wins.
    expect(resolveConfigFile({}, ['node', join(bundleDir, 'main.js')], dir)).toBe(
      join(bundleDir, 'conf', 'router.yaml'),
    );
  });
});

describe('the committed development seed', () => {
  /**
   * `conf/router.dev-seed.yaml` is what a developer boots the console against,
   * and `catalog.service.spec.ts` projects it into the catalogue. It has to load
   * through the same schema as any other config file.
   */
  it('loads through the runtime schema', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(join(REPO_ROOT, 'apps/router-api/conf/router.dev-seed.yaml'), 'utf8');

    const result = RouterConfigSchema.safeParse({ ...(parseYaml(raw) as object), auth: { secret: SECRET } });

    expect(result.success ? null : result.error.issues).toBeNull();
    expect(result.success && result.data.models).toHaveLength(8);
    expect(result.success && result.data.endpoints).toHaveLength(3);
  });
});

describe('the committed example configuration', () => {
  /**
   * `schemas/router-config.schema.json` is the contract; this schema is its
   * runtime mirror. Parsing the same example both validate against is what keeps
   * the two from drifting apart unnoticed.
   */
  it('satisfies the runtime schema as well as the JSON Schema', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(join(REPO_ROOT, 'schemas/examples/router-config.example.yaml'), 'utf8');
    const expanded = raw.replace(/\$\{[A-Z0-9_]+\}/g, 'x'.repeat(40));

    const result = RouterConfigSchema.safeParse(parseYaml(expanded));

    expect(result.success ? null : result.error.issues).toBeNull();
  });
});
