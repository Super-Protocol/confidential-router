/**
 * Bundle-size budget, carried over from swarm-cloud `libs/swarm-attestation`.
 *
 * The verifier is meant to be embeddable in a browser surface, and the secp256k1
 * fallback has to be imported eagerly (no lazy `import()` splits) so it is always
 * present. That makes the shipped size a real constraint rather than a guideline,
 * so it is asserted here instead of documented in prose: a browser build of the
 * package, with every dependency inlined, must stay under 200 KB gzipped.
 */

import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const BUDGET_BYTES = 200 * 1024;

async function browserBundleGzippedBytes(): Promise<number> {
  const result = await build({
    configFile: false,
    logLevel: 'error',
    resolve: { conditions: ['browser', 'import', 'module', 'default'] },
    build: {
      write: false,
      minify: 'esbuild',
      target: 'es2022',
      lib: {
        entry: fileURLToPath(new URL('../index.ts', import.meta.url)),
        formats: ['es'],
        fileName: 'attestation',
      },
      // No externals: measure what a consumer actually ships.
      rollupOptions: { external: [] },
    },
  });

  const bundles = Array.isArray(result) ? result : [result];
  const code = bundles
    .flatMap((bundle) => ('output' in bundle ? bundle.output : []))
    .filter((chunk) => chunk.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n');
  if (code.length === 0) throw new Error('the browser build produced no chunks');

  return gzipSync(Buffer.from(code, 'utf8')).byteLength;
}

describe('browser bundle size', () => {
  it(`stays under ${BUDGET_BYTES / 1024} KB gzipped with every dependency inlined`, async () => {
    const gzipped = await browserBundleGzippedBytes();
    expect(gzipped, `browser bundle is ${gzipped} bytes gzipped, budget is ${BUDGET_BYTES}`).toBeLessThan(BUDGET_BYTES);
  });
});
