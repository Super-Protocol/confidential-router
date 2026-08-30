import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type ConfigurationLoader,
  deepMerge,
  envConfiguration,
  validatedConfiguration,
  yamlConfiguration,
} from '@confidential-router/server-common';
import { registerAs } from '@nestjs/config';
import { type RouterConfig, RouterConfigSchema } from './config.schema.js';

export * from './config.schema.js';

/** Namespace under which the validated config is registered with `@nestjs/config`. */
export const ROUTER_CONFIG_NAMESPACE = 'router';

export const CONFIG_ENV_PREFIX = 'CR_API';

/** Overridable with `CR_API_CONFIG_FILE`; a missing file is not an error. */
export const DEFAULT_CONFIG_FILE = 'conf/router.yaml';

/**
 * `CR_API_*` names that are meta-variables rather than configuration.
 *
 * They live under the same prefix because that is where an operator looks for
 * them, but the env layer must skip them: `CR_API_VERSION` would otherwise
 * become `version: "1.2.3"` and collide with the config's own `version: 1`,
 * failing the boot on a variable that has nothing to do with the schema.
 */
export const RESERVED_ENV_SUFFIXES = ['CONFIG_FILE', 'VERSION'];

/** Build or release identifier, surfaced by `/health`. Never part of the config. */
export function serviceVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.CR_API_VERSION ?? '0.0.0';
}

/**
 * Finds the config file when `CR_API_CONFIG_FILE` is not set.
 *
 * `conf/router.yaml` under the working directory first — that is what a
 * container mounts. Then the same path next to the running bundle, which is
 * where the build copies `apps/router-api/conf` and therefore what
 * `nx serve router-api` (run from the workspace root) picks up.
 */
export function resolveConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  cwd: string = process.cwd(),
): string {
  if (env.CR_API_CONFIG_FILE) {
    return env.CR_API_CONFIG_FILE;
  }
  const candidates = [resolve(cwd, DEFAULT_CONFIG_FILE)];
  if (argv[1]) {
    candidates.push(resolve(dirname(argv[1]), DEFAULT_CONFIG_FILE));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export class MissingAuthSecretError extends Error {
  constructor() {
    super(
      'auth.secret is required in production. Set CR_API_AUTH__SECRET (at least 32 characters) ' +
        'or auth.secret in the config file. It signs session cookies and magic-link tokens; ' +
        'rotating it invalidates every session.',
    );
    this.name = 'MissingAuthSecretError';
  }
}

export interface LoadRouterConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Collects boot-time warnings; the caller logs them once a logger exists. */
  onWarning?: (message: string) => void;
}

/**
 * Two sources, in precedence order: `conf/router.yaml`, then `CR_API_*`
 * environment variables (`CR_API_SERVER__PORT=4000` → `server.port`). Schema
 * defaults fill in the rest, which is what lets `nx serve` boot on SQLite with
 * neither a config file nor a single environment variable set.
 */
export function loadRouterConfig(options: LoadRouterConfigOptions = {}): RouterConfig {
  const env = options.env ?? process.env;
  const warn = options.onWarning ?? (() => undefined);
  const configFile = resolveConfigFile(env);

  const yamlLayer = yamlConfiguration<RouterConfig>(configFile, env);
  const envLayer = envConfiguration<RouterConfig>(CONFIG_ENV_PREFIX, { env, reserved: RESERVED_ENV_SUFFIXES });
  const layers: Array<ConfigurationLoader<RouterConfig>> = [
    developmentDefaults(deepMerge(yamlLayer(), envLayer()), env, warn),
    yamlLayer,
    envLayer,
  ];

  const config = validatedConfiguration<RouterConfig>(layers, RouterConfigSchema)();

  if (config.models.length === 0) {
    warn('No models are configured — /v1 will answer every request with model_not_found.');
  }

  return config;
}

/**
 * The auth secret has no schema default on purpose. An unset one in production
 * is a security incident waiting to happen, so it fails the boot; outside
 * production a random one is minted per process, which means sessions do not
 * survive a restart — exactly the signal a developer needs that this value is
 * not configured.
 *
 * This is a *lowest-precedence* layer: anything the file or the environment
 * supplies wins over it.
 */
function developmentDefaults(
  supplied: Partial<RouterConfig>,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): ConfigurationLoader<RouterConfig> {
  const secret = supplied.auth?.secret;
  if (typeof secret === 'string' && secret.length > 0) {
    return () => ({});
  }
  if (env.NODE_ENV === 'production') {
    throw new MissingAuthSecretError();
  }
  warn(
    'auth.secret is not configured; this process minted an ephemeral one. ' +
      'Sessions will not survive a restart. Set CR_API_AUTH__SECRET before deploying.',
  );
  const generated = randomBytes(32).toString('hex');
  return () => ({ auth: { secret: generated } }) as Partial<RouterConfig>;
}

export const routerConfig = registerAs(ROUTER_CONFIG_NAMESPACE, () => loadRouterConfig());
