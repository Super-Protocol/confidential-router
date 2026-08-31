import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildConsoleSchema, CONSOLE_SCHEMA_PATH, printConsoleSchema } from './console-schema.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');
const SCHEMA_FILE = join(REPO_ROOT, CONSOLE_SCHEMA_PATH);

/**
 * Set by `pnpm nx run @confidential-router/router-api:schema` to rewrite the
 * committed SDL, the same way a snapshot is updated. CI never sets it, so there
 * the check can only fail — which is the point.
 */
const REGENERATE = process.env.CR_UPDATE_SCHEMA === '1';

describe('the committed console schema', () => {
  it('is exactly what the resolvers produce', async () => {
    const sdl = printConsoleSchema(await buildConsoleSchema());

    if (REGENERATE) {
      writeFileSync(SCHEMA_FILE, sdl, 'utf8');
    }

    expect(
      readFileSync(SCHEMA_FILE, 'utf8'),
      'apps/router-api/schema.graphql is stale. Run `pnpm nx run @confidential-router/router-api:schema`.',
    ).toBe(sdl);
  });
});
