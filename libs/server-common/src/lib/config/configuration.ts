import { existsSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import type { z } from 'zod';
import { deepMerge } from './deep-merge.js';
import { expandEnvPlaceholders } from './env-placeholders.js';

export type ConfigurationLoader<T> = () => Partial<T>;

/**
 * YAML source. A missing file is not an error: the schema's defaults plus env
 * overrides have to be enough on their own, which is what makes a zero-config
 * `nx serve` boot possible.
 */
export function yamlConfiguration<T>(
  yamlFilePath: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigurationLoader<T> {
  return () => {
    if (!existsSync(yamlFilePath)) {
      return {};
    }
    const parsed = load(readFileSync(yamlFilePath, 'utf8'));
    if (parsed === null || parsed === undefined) {
      return {};
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Configuration file ${yamlFilePath} must contain a YAML mapping at the top level.`);
    }
    return expandEnvPlaceholders(parsed as Partial<T>, env);
  };
}

export interface EnvConfigurationOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Suffixes under the same prefix that are *not* configuration.
   *
   * A service invariably wants a few meta-variables in its own namespace —
   * where to find the config file, what version it is — and without this each
   * of them would be mapped into the config tree, where it either collides with
   * a real key or is rejected by the schema. Compared case-insensitively
   * against the raw suffix, so `VERSION` reserves `<PREFIX>_VERSION`.
   */
  reserved?: string[];
}

/**
 * Environment source. `<PREFIX>_A__B_C=x` sets `a.bC = "x"`: `__` separates
 * object levels, `_` inside a level is read as snake_case and camelised so env
 * names stay shouty while the config tree keeps its TypeScript casing.
 *
 * Values are left as strings — the schema decides what each one should become
 * (see `coercion.ts`).
 */
export function envConfiguration<T>(prefix: string, options: EnvConfigurationOptions = {}): ConfigurationLoader<T> {
  const { env = process.env, reserved = [] } = options;
  const reservedSuffixes = new Set(reserved.map((name) => name.toUpperCase()));

  return () => {
    const prefixWithSeparator = `${prefix}_`;
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith(prefixWithSeparator) || value === undefined) {
        continue;
      }
      const suffix = key.slice(prefixWithSeparator.length);
      if (reservedSuffixes.has(suffix.toUpperCase())) {
        continue;
      }
      const path = suffix
        .split('__')
        .filter((segment) => segment !== '')
        .map(camelise);
      if (path.length === 0) {
        continue;
      }
      assign(result, path, value);
    }

    return result as Partial<T>;
  };
}

function camelise(segment: string): string {
  return segment
    .toLowerCase()
    .split('_')
    .filter((part) => part !== '')
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

function assign(target: Record<string, unknown>, path: string[], value: string): void {
  let current = target;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

export class ConfigurationValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    const details = issues
      .map((issue) => `  - ${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
      .join('\n');
    super(`Configuration validation failed:\n${details}`);
    this.name = 'ConfigurationValidationError';
    this.issues = issues;
  }
}

/**
 * The slice of a Zod schema this module needs. Declared structurally rather than
 * as `z.ZodType<T>` so a schema whose input type differs from its output type —
 * which is every schema with defaults or coercion — still matches.
 */
export interface ConfigurationSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: z.core.$ZodIssue[] } };
}

/**
 * Merges every source in order (later wins) and validates the result once.
 * Validation failures list every offending path rather than the first, because
 * a half-configured deployment usually gets several wrong at the same time.
 */
export function validatedConfiguration<T>(
  loaders: Array<ConfigurationLoader<T>>,
  schema: ConfigurationSchema<T>,
): () => T {
  return () => {
    const merged = deepMerge<T>(...loaders.map((loader) => loader() ?? {}));
    const result = schema.safeParse(merged);
    if (!result.success) {
      throw new ConfigurationValidationError(result.error.issues);
    }
    return result.data;
  };
}
