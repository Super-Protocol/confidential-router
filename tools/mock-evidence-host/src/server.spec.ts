/**
 * The mock is held to the repository's own verifier.
 *
 * A stand-in for the platform is only useful if what it publishes is what the
 * real pipeline accepts — and, just as importantly, if each deny path fails at
 * the stage it claims to. Both are checked here by running
 * `@confidential-router/attestation` over the live TLS endpoint, with the leaf
 * certificate observed on the very connection the bundle arrived over.
 */
import { connect, type TLSSocket } from 'node:tls';
import { type TrustedRoot, type VerifyResult, verifyHostname } from '@confidential-router/attestation';
import { EVIDENCE_PATH } from '@confidential-router/attestation-fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprintOf } from './pki.js';
import { type MockEvidenceHost, startMockEvidenceHost } from './server.js';

let host: MockEvidenceHost | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
});

interface Fetched {
  status: number;
  body: string;
  /** The leaf presented on this exact connection. */
  observedTlsFingerprint: string;
}

/**
 * One HTTP/1.1 GET over TLS, recording the peer certificate.
 *
 * Written by hand rather than with `fetch` because the point is the *observed*
 * channel binding: the fingerprint has to come from the connection that carried
 * the body, which `fetch` does not expose. The chain is not checked here — the
 * gatekeeper does not check it either (ADR-003 §1); trust comes from the
 * evidence chain and this fingerprint.
 */
function fetchOverTls(port: number, servername: string, path: string): Promise<Fetched> {
  return new Promise<Fetched>((resolve, reject) => {
    const socket: TLSSocket = connect({ port, host: '127.0.0.1', servername, rejectUnauthorized: false }, () => {
      const certificate = socket.getPeerX509Certificate();
      if (!certificate) {
        socket.destroy();
        reject(new Error('the mock presented no certificate'));
        return;
      }
      const observedTlsFingerprint = fingerprintOf(new Uint8Array(certificate.raw));
      // HTTP/1.0, so the response body arrives whole rather than chunked and
      // this helper stays a helper.
      socket.write(`GET ${path} HTTP/1.0\r\nHost: ${servername}\r\n\r\n`);

      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const separator = raw.indexOf('\r\n\r\n');
        const head = raw.slice(0, separator);
        resolve({
          status: Number(/^HTTP\/1\.\d (\d{3})/.exec(head)?.[1] ?? 0),
          body: raw.slice(separator + 4),
          observedTlsFingerprint,
        });
      });
    });
    socket.on('error', reject);
  });
}

/** Runs the real verifier against the live endpoint. */
async function verify(current: MockEvidenceHost, roots: TrustedRoot[]): Promise<VerifyResult> {
  const fetched = await fetchOverTls(current.port, current.hostname, EVIDENCE_PATH);
  return verifyHostname({
    hostname: current.hostname,
    observedTlsFingerprint: fetched.observedTlsFingerprint,
    trustedRoots: roots,
    maxBundleAge: 24 * 60 * 60 * 1000,
    fetcher: async () =>
      new Response(fetched.body, { status: fetched.status, headers: { 'content-type': 'application/json' } }),
  });
}

async function start(options: Parameters<typeof startMockEvidenceHost>[0] = {}): Promise<{
  current: MockEvidenceHost;
  roots: TrustedRoot[];
}> {
  host = await startMockEvidenceHost(options);
  return { current: host, roots: [{ name: 'mock-cloud', pem: host.trustedRootPem }] };
}

describe('mock-evidence-host', () => {
  it('publishes a bundle the real verifier accepts, bound to the live channel', async () => {
    const { current, roots } = await start();

    const result = await verify(current, roots);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('DeploymentEvidence');
    expect(result.channelBinding).toBe('observed');
    expect(result.matchedRoot.name).toBe('mock-cloud');
    expect(result.payload.hostname).toBe(current.hostname);
    expect((result.payload as { evidenceDigest: string }).evidenceDigest).toBe(current.evidenceDigest());
  });

  it('changes the digest on a redeployment and keeps the bundle valid', async () => {
    const { current, roots } = await start();
    const before = current.evidenceDigest();

    const after = await current.rotateDeployment('a-new-image');

    expect(after).not.toBe(before);
    expect(current.evidenceDigest()).toBe(after);
    const result = await verify(current, roots);
    // Still cryptographically sound: what a rotation breaks is the *pin*, which
    // is a policy decision the gatekeeper makes after this pipeline succeeds.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.payload as { evidenceDigest: string }).evidenceDigest).toBe(after);
    }
  });

  it('keeps the binding intact when the certificate rotates', async () => {
    const { current, roots } = await start();

    await current.rotateCertificate();

    const result = await verify(current, roots);
    expect(result.ok).toBe(true);
  });

  it('fails at tls-fingerprint when the bundle claims the previous certificate', async () => {
    const { current, roots } = await start();

    await current.breakChannelBinding();

    const result = await verify(current, roots);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('tls-fingerprint');
  });

  it('fails at untrusted-root when the chain re-terminates elsewhere', async () => {
    const { current, roots } = await start();

    await current.useOtherCloud();

    const result = await verify(current, roots);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('untrusted-root');
  });

  it('fails at fetch while the publisher is down, and recovers', async () => {
    const { current, roots } = await start();

    current.stopPublishing();
    const denied = await verify(current, roots);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.stage).toBe('fetch');
    }

    current.resumePublishing();
    expect((await verify(current, roots)).ok).toBe(true);
  });

  it('fails at jws when the bundle is published stale', async () => {
    const { current, roots } = await start({ issuedAtSkewMs: -48 * 60 * 60 * 1000 });

    const result = await verify(current, roots);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('jws');
  });

  it('restores every deny path at once', async () => {
    const { current, roots } = await start();
    const original = current.evidenceDigest();
    await current.rotateDeployment();
    await current.useOtherCloud();
    current.stopPublishing();

    await current.restore();

    expect(current.evidenceDigest()).toBe(original);
    expect((await verify(current, roots)).ok).toBe(true);
  });

  it('proxies everything but the evidence path to the upstream behind it', async () => {
    const { createServer } = await import('node:http');
    const upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ saw: request.url, host: request.headers.host }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;

    try {
      const { current } = await start({ upstream: `http://127.0.0.1:${upstreamPort}` });

      const proxied = await fetchOverTls(current.port, current.hostname, '/v1/models');

      expect(proxied.status).toBe(200);
      expect(JSON.parse(proxied.body)).toMatchObject({ saw: '/v1/models' });
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('answers 502 rather than hanging when it fronts no upstream', async () => {
    const { current } = await start();

    const response = await fetchOverTls(current.port, current.hostname, '/v1/models');

    expect(response.status).toBe(502);
  });

  it('exposes the control surface only when it was asked for', async () => {
    const closed = await startMockEvidenceHost();
    try {
      expect((await fetchOverTls(closed.port, closed.hostname, '/__mock/state')).status).toBe(404);
    } finally {
      await closed.close();
    }

    const { current } = await start({ controlApi: true });
    const state = await fetchOverTls(current.port, current.hostname, '/__mock/state');
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({ evidenceDigest: current.evidenceDigest(), publishing: true });

    const rotated = await fetchOverTls(current.port, current.hostname, '/__mock/rotate-deployment');
    expect(JSON.parse(rotated.body).evidenceDigest).toBe(current.evidenceDigest());

    const root = await fetchOverTls(current.port, current.hostname, '/__mock/root.pem');
    expect(root.body.trim()).toBe(current.trustedRootPem.trim());
  });
});
