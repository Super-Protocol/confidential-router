import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The admin section was built contract-first against an overlay while SUP-225
 * was in flight; the overlay and its identity check are gone now that the
 * resolvers emit the vocabulary into the committed SDL (the full
 * contract-document ↔ shipped-schema conformance check is SUP-237). What stays
 * are the two guards that are about the schema itself, not about the overlay:
 * the external vocabulary never collapses into the own-endpoint one (ADR-008
 * §1 / ADR-002), and nothing readable can carry the upstream key (threat T15).
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const SHIPPED_SCHEMA = join(REPO_ROOT, 'apps/router-api/schema.graphql');

describe('the shipped admin GraphQL vocabulary', () => {
  const sdl = readFileSync(SHIPPED_SCHEMA, 'utf8');

  it('keeps the external vocabulary out of the own-endpoint one', () => {
    // ADR-002: `EvidenceState` describes publication, and nothing in it may
    // claim a verdict. The external enum is where a verdict is allowed to live,
    // and only because every value names who reached it.
    expect(sdl).toContain('VERIFIED_BY_THIS_ROUTER');
    expect(sdl).toContain('DENIED_BY_THIS_ROUTER');
    expect(sdl).not.toMatch(/^\s+VERIFIED$/m);
    expect(sdl).not.toMatch(/^\s+DENIED$/m);
  });

  it('never exposes a field that could return the upstream key', () => {
    // `apiKey` appears only as mutation *input* (threat T15); the only readable
    // thing about the credential is its prefix.
    const start = sdl.indexOf('type ExternalEndpoint {');
    expect(start, 'type ExternalEndpoint is missing from the shipped schema').toBeGreaterThan(-1);
    const readable = sdl.slice(start, sdl.indexOf('}', start) + 1);
    expect(readable).not.toMatch(/\bapiKey\b/);
    expect(readable).toContain('apiKeyPrefix');
  });
});
