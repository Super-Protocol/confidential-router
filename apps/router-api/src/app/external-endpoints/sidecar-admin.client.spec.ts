import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchSidecarVerdicts, SidecarUnavailableError, type SidecarVerdict } from './sidecar-admin.client.js';

let server: Server | null = null;

/** A stand-in sidecar on loopback. Returns the `admin.listen` value for it. */
async function serving(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('the test server did not bind a port');
  }
  return `127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

const VERDICT: SidecarVerdict = {
  endpoint: 'upstream-a',
  health: 'confidential',
  admitted: true,
  report: { admitted: true, verified: true, evidenceDigest: 'sha256/abc' },
};

describe('fetchSidecarVerdicts', () => {
  it('reads the /verdicts document', async () => {
    const listen = await serving((request, response) => {
      expect(request.url).toBe('/verdicts');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([VERDICT]));
    });

    await expect(fetchSidecarVerdicts(listen)).resolves.toEqual([VERDICT]);
  });

  it('accepts an empty document — a sidecar with no endpoints yet', async () => {
    const listen = await serving((_request, response) => response.end('[]'));

    await expect(fetchSidecarVerdicts(listen)).resolves.toEqual([]);
  });

  it('refuses a body that is not the array the contract says', async () => {
    const listen = await serving((_request, response) => response.end('{"endpoints":[]}'));

    await expect(fetchSidecarVerdicts(listen)).rejects.toThrow(SidecarUnavailableError);
  });

  it('reports a non-200 with its status', async () => {
    const listen = await serving((_request, response) => {
      response.statusCode = 503;
      response.end('nope');
    });

    await expect(fetchSidecarVerdicts(listen)).rejects.toThrow(/answered 503/);
  });

  it('reports a body that is not JSON', async () => {
    const listen = await serving((_request, response) => response.end('not json'));

    await expect(fetchSidecarVerdicts(listen)).rejects.toThrow(/not JSON/);
  });

  it('reports a sidecar that is not listening at all', async () => {
    // The ordinary state while the sidecar container is still starting. It has to
    // surface as a named failure, because the poller's job is to log it once and
    // leave every endpoint at `pending`.
    await expect(fetchSidecarVerdicts('127.0.0.1:1')).rejects.toThrow(SidecarUnavailableError);
  });
});
