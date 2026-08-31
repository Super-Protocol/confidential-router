/**
 * A TLS front for the router that publishes `/.well-known/swarm-evidence`.
 *
 * In production the *platform* publishes a bundle for each router hostname and
 * the router never learns whether anyone verified it (ADR-002). There is no
 * platform in a test, so this stands in for one: it terminates TLS with a
 * certificate it minted, serves a freshly signed bundle binding that exact
 * certificate, and reverse-proxies everything else to the router behind it.
 *
 * Its reason to exist is the *deny* paths. A gatekeeper only proves it is
 * fail-closed when something it trusted stops being trustworthy while traffic
 * is flowing, so every stage of the verification pipeline is reachable from
 * here on demand:
 *
 *   rotateDeployment()      a redeployment — new snapshot, new evidenceDigest,
 *                           still cryptographically valid → denied at `policy`
 *                           until the new digest is pinned
 *   rotateCertificate()     a new TLS leaf, with the bundle following it → the
 *                           channel changes but stays attested
 *   breakChannelBinding()   the bundle keeps claiming the old certificate →
 *                           denied at `tls-fingerprint`
 *   useOtherCloud()         the chain re-terminates at a root the user never
 *                           trusted → denied at `untrusted-root`
 *   stopPublishing()        the endpoint 503s its own evidence → denied at
 *                           `fetch`
 *
 * The deployment snapshot and the TEE quote are taken verbatim from
 * `@confidential-router/attestation-fixtures`, so what is published here has
 * the same shape the conformance vectors pin. Nothing about it is attested:
 * the quote is a fixture blob and the root is minted in-process.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createSecureContext, type SecureContext } from 'node:tls';
import { EVIDENCE_PATH, loadBundle, loadConformanceManifest } from '@confidential-router/attestation-fixtures';
import {
  type Authority,
  base64Url,
  buildAuthority,
  type IssuedCertificate,
  otherCloudAuthoritySpec,
  sha256,
  signCompactJws,
  trustedAuthoritySpec,
} from './pki.js';

/** Where the control API lives when one is exposed. Never proxied upstream. */
export const CONTROL_PREFIX = '/__mock';

export interface MockEvidenceHostOptions {
  /**
   * The router this fronts, e.g. `http://127.0.0.1:3000`. Omit to serve only
   * the evidence document and 502 everything else — enough for a gatekeeper
   * verification test that never sends a request through.
   */
  upstream?: string;
  /**
   * The name the certificate carries and the bundle is published for. It has to
   * be a name the client resolves; `localhost` is the default because a test
   * cannot edit `/etc/hosts`.
   */
  hostname?: string;
  /** 0 (the default) binds an ephemeral port. */
  port?: number;
  /**
   * Expose the deny-path controls over HTTPS under `/__mock`. Off by default:
   * the returned handle is how a test drives them, and a script in another
   * process opts in explicitly.
   */
  controlApi?: boolean;
  /** `issuedAt` offset, so a caller can publish a bundle that is already stale. */
  issuedAtSkewMs?: number;
}

export interface MockEvidenceHost {
  /** `https://<hostname>:<port>` — what an endpoint's `upstream` is set to. */
  readonly url: string;
  readonly port: number;
  readonly hostname: string;
  /** PEM of the root a gatekeeper must trust for this host to verify. */
  readonly trustedRootPem: string;
  /** The digest published right now — the value to pin. */
  evidenceDigest(): string;
  /** The bundle as it would be served right now, signed afresh. */
  bundle(): Promise<Record<string, unknown>>;
  /** A redeployment: new snapshot, new digest. Returns the new digest. */
  rotateDeployment(marker?: string): Promise<string>;
  /** A new TLS leaf; the bundle is re-signed to bind it. */
  rotateCertificate(): Promise<void>;
  /** Keep claiming the old certFingerprint after the certificate changed. */
  breakChannelBinding(): Promise<void>;
  /** Re-chain to a root the gatekeeper was never given. */
  useOtherCloud(): Promise<void>;
  /** Undo every deny path: trusted authority, bound leaf, fixture snapshot. */
  restore(): Promise<void>;
  /** Answer the evidence path with 503, as an endpoint that lost its publisher. */
  stopPublishing(): void;
  resumePublishing(): void;
  close(): Promise<void>;
}

export interface DeploymentSnapshot {
  version: number;
  resources: unknown[];
  [key: string]: unknown;
}

/**
 * The snapshot and quote the vectors pin, so what this publishes matches the
 * shape the conformance suite already holds both verifiers to.
 */
function fixtureEvidence(): { snapshot: DeploymentSnapshot; quote: Record<string, unknown> | undefined } {
  const manifest = loadConformanceManifest();
  const valid = manifest.cases.find((testCase) => testCase.id === 'valid-rsa-deployment');
  if (!valid?.expect.ok) {
    throw new Error('the conformance manifest no longer carries a valid-rsa-deployment case');
  }
  const snapshot = valid.expect.payload.evidence as DeploymentSnapshot;
  const quote = loadBundle('valid-rsa-deployment').rootCaTeeQuote as Record<string, unknown> | undefined;
  return { snapshot, quote };
}

/**
 * The digest of a snapshot: sha256 over its JSON, exactly as
 * `libs/attestation-fixtures/tools/generate.ts` computes it.
 *
 * Nothing in the router or the gatekeeper recomputes a digest — both carry the
 * published one — but a mock that invented its digest would let the snapshot
 * and the digest drift apart, and a pin over that is pinning nothing in
 * particular.
 */
export function digestOf(snapshot: DeploymentSnapshot): string {
  return `sha256/${base64Url(sha256(JSON.stringify(snapshot)))}`;
}

/** A redeployment: the same snapshot shape, different container image digests. */
export function redeploy(snapshot: DeploymentSnapshot, marker: string): DeploymentSnapshot {
  const replacement = Buffer.from(sha256(marker)).toString('hex');
  const resources = JSON.parse(JSON.stringify(snapshot.resources)) as { containers?: { image?: string }[] }[];
  for (const resource of resources) {
    for (const container of resource.containers ?? []) {
      if (typeof container.image === 'string') {
        container.image = container.image.replace(/@sha256:[0-9a-f]{64}$/, `@sha256:${replacement}`);
      }
    }
  }
  return { ...snapshot, resources };
}

interface HostState {
  authority: Authority;
  leaf: IssuedCertificate;
  /** What the payload claims the TLS leaf is; normally the leaf's own. */
  boundFingerprint: string;
  snapshot: DeploymentSnapshot;
  publishing: boolean;
}

export async function startMockEvidenceHost(options: MockEvidenceHostOptions = {}): Promise<MockEvidenceHost> {
  const hostname = options.hostname ?? 'localhost';
  const issuedAtSkewMs = options.issuedAtSkewMs ?? 0;
  const { snapshot: fixtureSnapshot, quote } = fixtureEvidence();

  const trusted = await buildAuthority(trustedAuthoritySpec());
  const otherCloud = await buildAuthority(otherCloudAuthoritySpec());

  const state: HostState = {
    authority: trusted,
    leaf: await trusted.issueLeaf(hostname),
    boundFingerprint: '',
    snapshot: fixtureSnapshot,
    publishing: true,
  };
  state.boundFingerprint = state.leaf.fingerprint;

  async function currentBundle(): Promise<Record<string, unknown>> {
    const issuedAt = new Date(Date.now() + issuedAtSkewMs).toISOString();
    const payload = {
      version: '1',
      kind: 'DeploymentEvidence',
      hostname,
      issuedAt,
      certFingerprint: state.boundFingerprint,
      evidenceDigest: digestOf(state.snapshot),
      evidence: state.snapshot,
    };
    const bundle: Record<string, unknown> = {
      version: '1',
      kind: 'DeploymentEvidence',
      hostname,
      issuedAt,
      certFingerprint: state.boundFingerprint,
      jws: await signCompactJws(payload, state.leaf.privateKey),
      certChain: [state.leaf.pem, state.authority.intermediate.pem, state.authority.root.pem],
    };
    if (quote) {
      bundle.rootCaTeeQuote = quote;
    }
    return bundle;
  }

  const server = createHttpsServer({
    key: state.leaf.privateKeyPem,
    cert: chainPemOf(state),
    // The leaf changes while the server is up; SNICallback is what makes the
    // next handshake pick the new one up without rebinding the port.
    SNICallback: (_serverName, callback) => callback(null, secureContextFor(state)),
  });

  /** Every action `/__mock/<action>` accepts; anything else is a 404. */
  const CONTROL_ACTIONS = [
    '/root.pem',
    '/state',
    '/rotate-deployment',
    '/rotate-certificate',
    '/break-binding',
    '/other-cloud',
    '/stop-publishing',
    '/resume-publishing',
    '/restore',
  ] as const;
  type ControlAction = (typeof CONTROL_ACTIONS)[number];

  const host: MockEvidenceHost = {
    url: '',
    port: 0,
    hostname,
    trustedRootPem: trusted.root.pem,
    evidenceDigest: () => digestOf(state.snapshot),
    bundle: currentBundle,
    async rotateDeployment(marker?: string): Promise<string> {
      state.snapshot = redeploy(fixtureSnapshot, marker ?? `rotation-${Date.now().toString(36)}`);
      return digestOf(state.snapshot);
    },
    async rotateCertificate(): Promise<void> {
      state.leaf = await state.authority.issueLeaf(hostname);
      state.boundFingerprint = state.leaf.fingerprint;
      server.closeAllConnections();
    },
    async breakChannelBinding(): Promise<void> {
      const stale = state.leaf.fingerprint;
      state.leaf = await state.authority.issueLeaf(hostname);
      state.boundFingerprint = stale;
      server.closeAllConnections();
    },
    async useOtherCloud(): Promise<void> {
      state.authority = otherCloud;
      state.leaf = await otherCloud.issueLeaf(hostname);
      state.boundFingerprint = state.leaf.fingerprint;
      server.closeAllConnections();
    },
    async restore(): Promise<void> {
      state.authority = trusted;
      state.leaf = await trusted.issueLeaf(hostname);
      state.boundFingerprint = state.leaf.fingerprint;
      state.snapshot = fixtureSnapshot;
      state.publishing = true;
      server.closeAllConnections();
    },
    stopPublishing: () => {
      state.publishing = false;
    },
    resumePublishing: () => {
      state.publishing = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };

  async function handleControl(action: string, response: ServerResponse): Promise<void> {
    if (!(CONTROL_ACTIONS as readonly string[]).includes(action)) {
      writeJson(response, 404, { error: `no control action ${action}` });
      return;
    }
    switch (action as ControlAction) {
      case '/root.pem':
        response.writeHead(200, { 'content-type': 'application/x-pem-file' });
        response.end(trusted.root.pem);
        return;
      case '/state':
        writeJson(response, 200, {
          hostname,
          evidenceDigest: digestOf(state.snapshot),
          authority: state.authority.name,
          certFingerprint: state.leaf.fingerprint,
          boundFingerprint: state.boundFingerprint,
          publishing: state.publishing,
        });
        return;
      case '/rotate-deployment':
        writeJson(response, 200, { evidenceDigest: await host.rotateDeployment() });
        return;
      case '/rotate-certificate':
        await host.rotateCertificate();
        writeJson(response, 200, { certFingerprint: state.leaf.fingerprint });
        return;
      case '/break-binding':
        await host.breakChannelBinding();
        writeJson(response, 200, { boundFingerprint: state.boundFingerprint });
        return;
      case '/other-cloud':
        await host.useOtherCloud();
        writeJson(response, 200, { authority: state.authority.name });
        return;
      case '/stop-publishing':
        host.stopPublishing();
        writeJson(response, 200, { publishing: false });
        return;
      case '/resume-publishing':
        host.resumePublishing();
        writeJson(response, 200, { publishing: true });
        return;
      case '/restore':
        await host.restore();
        writeJson(response, 200, { evidenceDigest: digestOf(state.snapshot), authority: state.authority.name });
    }
  }

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '/').split('?')[0];

    if (path === EVIDENCE_PATH) {
      if (!state.publishing) {
        writeJson(response, 503, { error: 'the evidence publisher is unavailable' });
        return;
      }
      currentBundle().then(
        (bundle) => writeJson(response, 200, bundle),
        (error: Error) => writeJson(response, 500, { error: error.message }),
      );
      return;
    }
    if (path.startsWith(CONTROL_PREFIX)) {
      if (!options.controlApi) {
        writeJson(response, 404, { error: 'the control API is not enabled on this host' });
        return;
      }
      void handleControl(path.slice(CONTROL_PREFIX.length), response);
      return;
    }
    if (!options.upstream) {
      writeJson(response, 502, { error: 'this mock evidence host fronts no upstream' });
      return;
    }
    proxy(request, response, options.upstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return Object.assign(host, { url: `https://${hostname}:${port}`, port });
}

/**
 * The chain the server presents, leaf first.
 *
 * It has to be in `cert`, not in `ca`: on a TLS *server* `ca` configures client
 * certificate verification and is never sent. A leaf on its own leaves a client
 * that trusts only the root unable to build a path to it — which is how the
 * router's evidence poller, running with this root in `NODE_EXTRA_CA_CERTS`,
 * finds out.
 */
function chainPemOf(state: HostState): string {
  // Each block is newline-terminated before being joined: OpenSSL reads the
  // bundle as a stream and a missing newline glues `-----END-----` onto the next
  // `-----BEGIN-----`, which it reports as "bad end line".
  return [state.leaf.pem, state.authority.intermediate.pem, state.authority.root.pem]
    .map((pem) => `${pem.trimEnd()}\n`)
    .join('');
}

/** The certificate the *next* handshake will present. */
function secureContextFor(state: HostState): SecureContext {
  return createSecureContext({ key: state.leaf.privateKeyPem, cert: chainPemOf(state) });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body, null, 2));
}

/**
 * Hop-by-hop headers, which belong to one connection and must not be forwarded
 * (RFC 9110 §7.6.1). Copying `transfer-encoding` in particular would tell the
 * client a framing that this hop is not the one using.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function withoutHopByHop<T extends Record<string, unknown>>(headers: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())),
  ) as Partial<T>;
}

/** Streams a request through to the router behind this front. */
function proxy(request: IncomingMessage, response: ServerResponse, upstream: string): void {
  const target = new URL(request.url ?? '/', upstream);
  const forwarded = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers: { ...withoutHopByHop(request.headers), host: target.host },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, withoutHopByHop(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    },
  );
  forwarded.on('error', (error: Error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    writeJson(response, 502, { error: `upstream unreachable: ${error.message}` });
  });
  request.pipe(forwarded);
}
