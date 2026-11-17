/**
 * A stand-in for `raw.githubusercontent.com/Super-Protocol/sp-vm/main/signatures`:
 * one directory served read-only over plain HTTP, 404 for anything absent.
 *
 * It exists so the stand's gatekeeper can run the *real* registry lookup —
 * `attestedroot.HTTPRegistry`, with the shipped folder map and pinned key —
 * against the committed cut of the real registry layout, instead of asserting
 * `inRegistry: true` from a fixture. The server does nothing the real host does
 * not: no listing, no rewriting, just the bytes at the path.
 */

import { createReadStream, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, normalize, resolve, sep } from 'node:path';

export interface RegistryServer {
  /** `http://127.0.0.1:<port>` — what `GATEKEEPER_TESTSTAND_REGISTRY_BASE_URL` is set to. */
  readonly url: string;
  close(): Promise<void>;
}

export async function startRegistryServer(directory: string): Promise<RegistryServer> {
  const root = resolve(directory);
  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const file = normalize(join(root, path));
    // Inside the directory, a regular file, GET only — anything else is a 404,
    // which is what the real host says for a measurement it does not sign.
    if (request.method !== 'GET' || !file.startsWith(root + sep) || !isFile(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
