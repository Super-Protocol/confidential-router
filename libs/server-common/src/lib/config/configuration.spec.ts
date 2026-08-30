import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { booleanish, integerish, stringArrayish } from './coercion.js';
import {
  ConfigurationValidationError,
  envConfiguration,
  validatedConfiguration,
  yamlConfiguration,
} from './configuration.js';
import { deepMerge } from './deep-merge.js';
import { parseDuration } from './duration.js';
import { expandEnvPlaceholders, MissingEnvPlaceholderError } from './env-placeholders.js';

// Shaped like a real service config: sections whose values all have defaults are
// themselves defaulted, so an empty file still validates.
const Schema = z.object({
  server: z
    .object({
      port: integerish().prefault(3000),
      validClientOrigins: stringArrayish().prefault([]),
    })
    .prefault({}),
  database: z.object({
    url: z.string(),
    logging: booleanish().prefault(false),
  }),
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeYaml(contents: string): string {
  const path = join(dir, 'router.yaml');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('yamlConfiguration', () => {
  it('returns an empty object when the file does not exist', () => {
    expect(yamlConfiguration(join(dir, 'absent.yaml'))()).toEqual({});
  });

  it('returns an empty object for an empty file', () => {
    expect(yamlConfiguration(writeYaml(''))()).toEqual({});
  });

  it('parses a mapping', () => {
    const loaded = yamlConfiguration<{ server: { port: number } }>(writeYaml('server:\n  port: 4100\n'))();
    expect(loaded).toEqual({ server: { port: 4100 } });
  });

  it('rejects a top-level sequence', () => {
    expect(() => yamlConfiguration(writeYaml('- a\n- b\n'))()).toThrow(/must contain a YAML mapping/);
  });
});

describe('expandEnvPlaceholders', () => {
  it('substitutes set variables anywhere in the tree', () => {
    const expanded = expandEnvPlaceholders({ a: { b: ['${CR_TEST_X}', 'plain'] } }, { CR_TEST_X: 'value' });
    expect(expanded).toEqual({ a: { b: ['value', 'plain'] } });
  });

  it('uses the default when the variable is unset or empty', () => {
    expect(expandEnvPlaceholders('${CR_TEST_X:-fallback}', {})).toBe('fallback');
    expect(expandEnvPlaceholders('${CR_TEST_X:-fallback}', { CR_TEST_X: '' })).toBe('fallback');
  });

  it('reports every missing variable at once', () => {
    expect(() => expandEnvPlaceholders({ a: '${CR_TEST_B}', b: '${CR_TEST_A}' }, {})).toThrow(
      MissingEnvPlaceholderError,
    );
    try {
      expandEnvPlaceholders({ a: '${CR_TEST_B}', b: '${CR_TEST_A}' }, {});
    } catch (error) {
      expect((error as MissingEnvPlaceholderError).variables).toEqual(['CR_TEST_A', 'CR_TEST_B']);
    }
  });
});

describe('envConfiguration', () => {
  it('maps __ to nesting and snake_case to camelCase', () => {
    const loaded = envConfiguration('CR_API', {
      CR_API_SERVER__PORT: '4200',
      CR_API_AUTH__GITHUB__CLIENT_ID: 'gh-id',
      OTHER_SERVER__PORT: '1',
    })();
    expect(loaded).toEqual({ server: { port: '4200' }, auth: { github: { clientId: 'gh-id' } } });
  });

  it('leaves values as strings so the schema decides their type', () => {
    const loaded = envConfiguration('CR_API', { CR_API_DATABASE__LOGGING: 'true' })() as Record<string, unknown>;
    expect(loaded.database).toEqual({ logging: 'true' });
  });

  it('ignores the bare prefix with nothing after it', () => {
    expect(envConfiguration('CR_API', { CR_API_: 'x' })()).toEqual({});
  });
});

describe('deepMerge', () => {
  it('merges nested objects and replaces arrays wholesale', () => {
    const merged = deepMerge<Record<string, unknown>>(
      { a: { b: 1, c: 2 }, list: ['x', 'y'] },
      { a: { c: 3 }, list: ['z'] },
    );
    expect(merged).toEqual({ a: { b: 1, c: 3 }, list: ['z'] });
  });

  it('skips undefined values so an absent source cannot erase an earlier one', () => {
    expect(deepMerge<Record<string, unknown>>({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });
});

describe('validatedConfiguration', () => {
  it('lets env override YAML and coerces string values per the schema', () => {
    const path = writeYaml(
      ['server:', '  port: 3000', '  validClientOrigins: [https://a.example]', 'database:', '  url: sqlite:a', ''].join(
        '\n',
      ),
    );
    const config = validatedConfiguration(
      [
        yamlConfiguration(path),
        envConfiguration('CR_API', {
          CR_API_SERVER__PORT: '4300',
          CR_API_SERVER__VALID_CLIENT_ORIGINS: 'https://b.example, https://c.example',
          CR_API_DATABASE__LOGGING: 'true',
        }),
      ],
      Schema,
    )();

    expect(config).toEqual({
      server: { port: 4300, validClientOrigins: ['https://b.example', 'https://c.example'] },
      database: { url: 'sqlite:a', logging: true },
    });
  });

  it('applies schema defaults when no source supplies a value', () => {
    const config = validatedConfiguration([envConfiguration('CR_API', { CR_API_DATABASE__URL: 'sqlite:a' })], Schema)();
    expect(config.server).toEqual({ port: 3000, validClientOrigins: [] });
  });

  it('reports every invalid path in one error', () => {
    const loader = validatedConfiguration(
      [envConfiguration('CR_API', { CR_API_SERVER__PORT: 'not-a-number' })],
      Schema,
    );
    expect(loader).toThrow(ConfigurationValidationError);
    try {
      loader();
    } catch (error) {
      const paths = (error as ConfigurationValidationError).issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('server.port');
      // The whole `database` section is missing, so that is the path reported.
      expect(paths).toContain('database');
    }
  });

  it('does not turn an all-digit secret into a number', () => {
    const schema = z.object({ auth: z.object({ secret: z.string() }) });
    const config = validatedConfiguration(
      [envConfiguration('CR_API', { CR_API_AUTH__SECRET: '1234567890' })],
      schema,
    )();
    expect(config.auth.secret).toBe('1234567890');
  });
});

describe('parseDuration', () => {
  it.each([
    ['5s', 5_000],
    ['120s', 120_000],
    ['5m', 300_000],
    ['24h', 86_400_000],
    ['1h30m', 5_400_000],
    ['250ms', 250],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it('rejects an unknown unit', () => {
    expect(() => parseDuration('5 seconds')).toThrow(/Invalid duration/);
  });
});

describe('booleanish', () => {
  it.each([
    ['true', true],
    ['FALSE', false],
    ['1', true],
    ['off', false],
  ])('accepts %s', (input, expected) => {
    expect(booleanish().parse(input)).toBe(expected);
  });

  it('rejects a value that is neither', () => {
    expect(() => booleanish().parse('maybe')).toThrow();
  });
});
