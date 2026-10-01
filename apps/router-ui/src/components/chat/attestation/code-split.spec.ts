import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The chat screen's bundle must not grow for a reader who never opens the
 * inspector.
 *
 * That was an explicit condition on this work, and it is a property of the
 * *module graph* rather than of a number: react-flow and everything under
 * `attestation/` may be reachable from the chat screen only through a dynamic
 * `import()`, which is what makes the bundler emit them as a separate chunk. A
 * byte budget would also catch a regression, but it would catch it as "the
 * number went up" — this says which import did it.
 *
 * The walk below is deliberately crude: it reads source text and follows static
 * `import`/`export … from` specifiers, skipping `import type`, which the
 * compiler erases and which therefore costs nothing at runtime. It is not a
 * resolver and does not need to be; a false positive here is a one-line fix and
 * a false negative is the bug this file exists to prevent.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT = resolve(HERE, '..');
const SRC = resolve(HERE, '..', '..', '..');

/** Static specifiers of one module, with type-only imports dropped. */
function staticImportsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  // `import x from 's'`, `import 's'`, `export … from 's'` — and not `import('s')`,
  // which has no `from` and is preceded by a parenthesis rather than whitespace.
  const pattern = /(?:^|\n)\s*(import|export)\s+(?!type\b)([^;'"]*?from\s*)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[3];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // Not this spelling; try the next.
    }
  }
  return null;
}

interface Reachable {
  /** Workspace-relative paths of every module reachable through static imports. */
  files: Set<string>;
  /** Bare package specifiers reached the same way. */
  packages: Set<string>;
}

function reachableFrom(entry: string): Reachable {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.add(relative(SRC, file));

    for (const specifier of staticImportsOf(file)) {
      const resolved = resolveRelative(file, specifier);
      if (resolved) {
        queue.push(resolved);
      } else if (!specifier.startsWith('.')) {
        packages.add(specifier.replace(/^(@[^/]+\/[^/]+|[^@/][^/]*).*$/, '$1'));
      }
    }
  }

  return { files, packages };
}

describe('the chat screen’s bundle', () => {
  const chatScreen = reachableFrom(resolve(CHAT, 'chat-screen.tsx'));

  it('does not statically reach react-flow', () => {
    expect([...chatScreen.packages]).not.toContain('@xyflow/react');
  });

  it('reaches the inspector’s button, and nothing else under attestation/', () => {
    // The button is the whole of the feature's footprint on the chat screen. If
    // anything else here turns up, something imported the panel statically.
    const attestation = [...chatScreen.files].filter((file) => file.includes('chat/attestation'));

    expect(attestation).toEqual(['components/chat/attestation/inspect-button.tsx']);
  });

  it('is not passing vacuously: the inspector really does pull react-flow in', () => {
    const inspector = reachableFrom(resolve(HERE, 'inspector.tsx'));

    expect([...inspector.packages]).toContain('@xyflow/react');
    expect([...inspector.files]).toContain('components/chat/attestation/graph-model.ts');
  });

  it('loads the inspector through a dynamic import, not a static one', () => {
    const source = readFileSync(resolve(HERE, 'inspect-button.tsx'), 'utf8');

    expect(source).toMatch(/React\.lazy\(\(\) => import\('\.\/inspector'\)\)/);
    expect(staticImportsOf(resolve(HERE, 'inspect-button.tsx'))).not.toContain('./inspector');
  });
});
