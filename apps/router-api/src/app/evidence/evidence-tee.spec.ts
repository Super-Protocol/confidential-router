import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { teeLabelOfBundle, teeLabelOfEvidence } from './evidence-tee.js';

/** Provenance of each root: `testdata/README.md`. */
const TESTDATA = fileURLToPath(new URL('./testdata', import.meta.url));
const root = (file: string) => readFileSync(join(TESTDATA, file), 'utf8');

/** A bundle as stored, reduced to the member the reader looks at. */
const bundleEndingIn = (...chain: unknown[]) => ({ certChain: chain });

describe('teeLabelOfBundle', () => {
  it('names the production deployment AMD SEV-SNP (Azure), whatever the config declares (SUP-270)', () => {
    expect(teeLabelOfBundle(bundleEndingIn('leaf', root('prod-router-azure-sev-snp-root.pem')))).toBe(
      'AMD SEV-SNP (Azure)',
    );
  });

  it('names a TDX deployment by its own branch', () => {
    expect(teeLabelOfBundle(bundleEndingIn(root('synthetic-tdx-azure-root.pem')))).toBe('Intel TDX (Azure)');
  });

  it('reads the root, not whichever certificate happens to carry evidence', () => {
    // The TDX root placed as the leaf must not leak its label onto the chain.
    expect(teeLabelOfBundle(bundleEndingIn(root('synthetic-tdx-azure-root.pem'), 'not a pem'))).toBeNull();
  });

  it.each([
    ['no chain', {}],
    ['an empty chain', bundleEndingIn()],
    ['a non-string root', bundleEndingIn(42)],
    [
      'a root that is not a certificate',
      bundleEndingIn('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'),
    ],
  ])('says nothing rather than throwing for %s', (_case, bundle) => {
    expect(teeLabelOfBundle(bundle)).toBeNull();
  });
});

describe('teeLabelOfEvidence', () => {
  /** One length-delimited protobuf field carrying `body`. */
  const branch = (field: number, body: number[] = [0x0a, 0x00]) => [(field << 3) | 2, body.length, ...body];

  it.each([
    [1, 'AMD SEV-SNP (QEMU)'],
    [2, 'Intel TDX (QEMU)'],
    [3, 'Intel TDX (GCP)'],
    [4, 'Intel TDX (Azure)'],
    [5, 'AMD SEV-SNP (Azure)'],
  ])('maps branch %i to %s, as the gatekeeper and the browser reader do', (field, label) => {
    expect(teeLabelOfEvidence(new Uint8Array(branch(field)))).toBe(label);
  });

  it('skips fields it does not know, so a newer producer still reads', () => {
    expect(teeLabelOfEvidence(new Uint8Array([0x78, 0x01, ...branch(9), ...branch(2)]))).toBe('Intel TDX (QEMU)');
  });

  it('refuses two branches rather than picking one', () => {
    expect(teeLabelOfEvidence(new Uint8Array([...branch(2), ...branch(5)]))).toBeNull();
  });

  it('names nothing for a message with no hardware branch', () => {
    expect(teeLabelOfEvidence(new Uint8Array(branch(9)))).toBeNull();
  });

  it('throws on a truncated message, which the bundle reader turns into null', () => {
    expect(() => teeLabelOfEvidence(new Uint8Array([0x2a, 0x7f]))).toThrow(/past the end/);
  });
});
