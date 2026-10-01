#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
/**
 * How much JavaScript the `/chat` route ships, and where the attestation
 * inspector ended up.
 *
 * The structural guarantee — that nothing under `components/chat/attestation`
 * except the entry button is reachable from the chat screen through a static
 * import — is asserted in CI by
 * `src/components/chat/attestation/code-split.spec.ts`. This script is the other
 * half: the number, for a reviewer who wants to see it rather than read about it,
 * and the chunk react-flow actually landed in.
 *
 * Usage, after `pnpm nx build router-ui`:
 *
 *     node apps/router-ui/tools/chat-bundle-size.mjs [path/to/.next]
 *
 * The chunk set is taken from the route's own client-reference manifest plus the
 * shared root files, which together are what a browser fetches for a cold load of
 * `/chat`. Lazily-loaded chunks are absent from that set by construction, which
 * is the thing worth seeing.
 */
import { gzipSync } from 'node:zlib';

const next = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '.next'));
const ROUTE = '/(console)/chat/page';

function chatChunks() {
  const manifest = readFileSync(join(next, 'server/app/(console)/chat/page_client-reference-manifest.js'), 'utf8');
  const match = manifest.match(/__RSC_MANIFEST\["\/\(console\)\/chat\/page"\] = (\{[\s\S]*?\});\s*$/);
  if (!match) throw new Error(`no client-reference manifest for ${ROUTE} in ${next}`);
  const chunks = new Set();
  for (const module of Object.values(JSON.parse(match[1]).clientModules)) {
    for (const chunk of module.chunks ?? []) {
      if (chunk.endsWith('.js')) chunks.add(chunk.replace(/^\/_next\//, ''));
    }
  }
  const root = JSON.parse(readFileSync(join(next, 'server/app/(console)/chat/page/build-manifest.json'), 'utf8'));
  for (const file of [...(root.rootMainFiles ?? []), ...(root.polyfillFiles ?? [])]) chunks.add(file);
  return chunks;
}

function measure(paths) {
  let raw = 0;
  let gzip = 0;
  for (const path of paths) {
    const file = join(next, path);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    raw += bytes.byteLength;
    gzip += gzipSync(bytes, { level: 9 }).byteLength;
  }
  return { raw, gzip };
}

const chunks = chatChunks();
const route = measure(chunks);
console.log(`/chat cold load: ${chunks.size} client chunks, ${kb(route.raw)} raw, ${kb(route.gzip)} gzipped`);

/* Where the panel went. Matched on a string only the inspector contains. */
const MARKER = 'Drawn from the signed evidence';
const dir = join(next, 'static/chunks');
for (const name of readdirSync(dir)) {
  if (!name.endsWith('.js')) continue;
  const path = join('static/chunks', name);
  if (!readFileSync(join(next, path), 'utf8').includes(MARKER)) continue;
  const { raw, gzip } = measure([path]);
  const inRoute = chunks.has(path);
  console.log(
    `attestation inspector: ${name}, ${kb(raw)} raw, ${kb(gzip)} gzipped — ` +
      `${inRoute ? 'IN the /chat cold load (the code split has regressed)' : 'not in the /chat cold load'}`,
  );
  if (inRoute) process.exitCode = 1;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

if (statSync(next).isDirectory() === false) process.exitCode = 1;
