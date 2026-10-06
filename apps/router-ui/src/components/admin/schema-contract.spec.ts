import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, print } from 'graphql';
import { describe, expect, it } from 'vitest';

/**
 * The admin section is built contract-first, against a vocabulary SUP-225 is
 * implementing in parallel, so these three files have to agree or the two
 * implementations drift silently:
 *
 * - `docs/contracts/console-graphql.md` — the contract, where a change lands first;
 * - `apps/router-ui/schema.contract-pending.graphql` — the same SDL, as the
 *   overlay codegen reads while the real schema cannot carry it;
 * - `apps/router-api/schema.graphql` — the committed SDL, emitted from the
 *   resolvers, which is where this vocabulary belongs once SUP-225 lands.
 *
 * This suite is what makes "no silent drift" a build failure.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const CONTRACT = join(REPO_ROOT, 'docs/contracts/console-graphql.md');
const OVERLAY = join(REPO_ROOT, 'apps/router-ui/schema.contract-pending.graphql');
const SHIPPED_SCHEMA = join(REPO_ROOT, 'apps/router-api/schema.graphql');

/**
 * Both sides through `print(parse(…))`, so the comparison is of the schema and
 * not of its whitespace: biome formats the `.graphql` file and leaves the fenced
 * block in the Markdown alone, and a re-indented docstring is not a drift.
 */
function normalise(sdl: string): string {
  return print(parse(sdl));
}

/** The overlay without its leading `#` explanation — the SDL itself. */
function overlaySdl(): string {
  const lines = readFileSync(OVERLAY, 'utf8').split('\n');
  let start = 0;
  while (start < lines.length && (lines[start].startsWith('#') || lines[start].trim() === '')) start += 1;
  return `${lines.slice(start).join('\n').trimEnd()}\n`;
}

/** The one fenced `graphql` block of the admin-section chapter. */
function contractSdl(): string {
  const doc = readFileSync(CONTRACT, 'utf8');
  const heading = doc.indexOf('## As shipped (SUP-225) — the admin section');
  expect(heading, 'the admin-section chapter is missing from docs/contracts/console-graphql.md').toBeGreaterThan(-1);

  const fence = doc.indexOf('```graphql', heading);
  const open = doc.indexOf('\n', fence) + 1;
  const close = doc.indexOf('```', open);
  return doc.slice(open, close);
}

describe('the admin GraphQL contract', () => {
  it('is spelled identically in the contract document and the codegen overlay', () => {
    expect(
      normalise(overlaySdl()),
      'apps/router-ui/schema.contract-pending.graphql and the SDL block in docs/contracts/console-graphql.md have diverged. The contract document is the source — change it there and copy it across.',
    ).toBe(normalise(contractSdl()));
  });

  /**
   * The tripwire. Once SUP-225's resolvers emit these types into the committed
   * SDL, the overlay is not merely redundant — it is a second definition of the
   * same vocabulary that nothing keeps in step. This failure is the instruction
   * to remove it, and the whole fix is `rm` plus a codegen run.
   */
  it('still needs the overlay — SUP-225 has not landed yet', () => {
    const shipped = readFileSync(SHIPPED_SCHEMA, 'utf8');

    expect(
      shipped.includes('externalEndpoints'),
      'SUP-225 has landed: apps/router-api/schema.graphql now defines the admin vocabulary. Delete apps/router-ui/schema.contract-pending.graphql, drop it from apps/router-ui/codegen.ts, rerun `pnpm nx run router-ui:codegen`, and delete this test.',
    ).toBe(false);
  });

  it('keeps the external vocabulary out of the own-endpoint one', () => {
    const sdl = overlaySdl();

    // ADR-002: `EvidenceState` describes publication, and nothing in it may
    // claim a verdict. The external enum is where a verdict is allowed to live,
    // and only because every value names who reached it.
    expect(sdl).toContain('VERIFIED_BY_THIS_ROUTER');
    expect(sdl).toContain('DENIED_BY_THIS_ROUTER');
    expect(sdl).not.toMatch(/^\s+VERIFIED$/m);
    expect(sdl).not.toMatch(/^\s+DENIED$/m);
  });

  it('never exposes a field that could return the upstream key', () => {
    const sdl = overlaySdl();

    // `apiKey` appears only as mutation *input* (threat T15); the only readable
    // thing about the credential is its prefix.
    const readable = sdl.slice(sdl.indexOf('type ExternalEndpoint {'), sdl.indexOf('input ExternalModelInput'));
    expect(readable).not.toMatch(/\bapiKey\b/);
    expect(readable).toContain('apiKeyPrefix');
  });
});
