import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSOLE_SCHEMA_PATH, printConsoleSchema } from '../src/app/api/graphql/console-schema.js';
import { createHarness, type Harness } from './app-harness.js';

/**
 * The committed SDL against the API that actually boots.
 *
 * `schema.spec.ts` checks the file against the schema built from the resolver
 * metadata; this checks it against the schema the running application serves.
 * The two together are what make `apps/router-api/schema.graphql` — and so the
 * client `apps/router-ui` is generated from — a fact about the deployed API
 * rather than a document someone remembered to update.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('the running API', () => {
  it('serves exactly the schema that is committed', () => {
    const running = harness.app.get(GraphQLSchemaHost).schema;

    expect(
      printConsoleSchema(running),
      'apps/router-api/schema.graphql is stale. Run `pnpm nx run @confidential-router/router-api:schema`.',
    ).toBe(readFileSync(join(REPO_ROOT, CONSOLE_SCHEMA_PATH), 'utf8'));
  });
});
