/**
 * A mock `/.well-known/swarm-evidence` publisher for the compose demo stack.
 *
 * In production the *platform* publishes a bundle for each router hostname and
 * the router only retrieves it (ADR-002). On a laptop there is no platform, so
 * the endpoints in the demo catalogue read "Not published" and every evidence
 * screen is empty. This stands in for the publisher: a real RSA PKI minted at
 * startup, a real RS256 JWS over a real DeploymentEvidence payload, re-signed
 * periodically so `issuedAt` stays fresh.
 *
 * **It attests nothing.** The quote is a fabricated blob, the root is generated
 * here, and the certificate says only what this process put in it. It exists so
 * the evidence pipeline has something correctly shaped to carry — not so anyone
 * can conclude anything from what it carries.
 *
 * `GET /roots/demo-root.pem` serves the root certificate: that is what you would
 * add to a gatekeeper's `trustedRoots` to make this stack verify end to end.
 *
 *   EVIDENCE_ENDPOINTS='llama-33-70b=llama-33-70b.tee.swarm.cloud' node evidence-publisher.mjs
 *
 * No npm dependencies on purpose — `openssl` (in the image) mints the
 * certificates, `node:crypto` signs the JWS.
 */
import { execFileSync } from 'node:child_process';
import { createHash, createSign, X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 8081);
const HOST = process.env.HOST ?? '0.0.0.0';
const PKI_DIR = process.env.EVIDENCE_PKI_DIR ?? '/tmp/evidence-pki';
const ROOT_PATH = '/roots/demo-root.pem';
const EVIDENCE_PATH = '/.well-known/swarm-evidence';

/**
 * How often a bundle is re-signed. A gatekeeper rejects a bundle older than its
 * freshness window, so a demo left running overnight has to keep publishing.
 */
const REISSUE_MS = Number(process.env.EVIDENCE_REISSUE_MS ?? 60_000);

/** `name=hostname` pairs — the `endpoints[]` of the router's configuration. */
function parseEndpoints(raw) {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, hostname] = entry.split('=').map((part) => part.trim());
      if (!name || !hostname) {
        throw new Error(`EVIDENCE_ENDPOINTS entry "${entry}" is not "<name>=<hostname>"`);
      }
      return [name, hostname];
    });
  if (entries.length === 0) {
    throw new Error('EVIDENCE_ENDPOINTS is empty; nothing to publish.');
  }
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// PKI
// ---------------------------------------------------------------------------

const openssl = (args) => execFileSync('openssl', args, { cwd: PKI_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

function createRoot() {
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'root.key',
    '-out',
    'root.pem',
    '-days',
    '3650',
    '-subj',
    '/O=Confidential Router Demo/CN=Confidential Router Demo Root',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  return readFileSync(join(PKI_DIR, 'root.pem'), 'utf8');
}

function createLeaf(name, hostname) {
  const key = `${name}.key`;
  const csr = `${name}.csr`;
  const cert = `${name}.pem`;
  const ext = `${name}.ext`;

  writeFileSync(
    join(PKI_DIR, ext),
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=DNS:${hostname}`,
      '',
    ].join('\n'),
  );

  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${hostname}`]);
  openssl([
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    'root.pem',
    '-CAkey',
    'root.key',
    '-CAcreateserial',
    '-out',
    cert,
    '-days',
    '825',
    '-sha256',
    '-extfile',
    ext,
  ]);
  rmSync(join(PKI_DIR, csr));

  return {
    certificate: readFileSync(join(PKI_DIR, cert), 'utf8'),
    privateKey: readFileSync(join(PKI_DIR, key), 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

const base64url = (buffer) => Buffer.from(buffer).toString('base64url');
const sha256 = (input) => createHash('sha256').update(input).digest();

/**
 * The canonical deployment snapshot the digest is taken over. Derived from the
 * hostname alone and therefore stable across re-issues: the console renders a
 * digest *history*, and a digest that changed every minute would read as a
 * redeployment every minute.
 */
function snapshotFor(name, hostname) {
  const tag = base64url(sha256(hostname)).slice(0, 12).toLowerCase();
  return {
    version: 2,
    resources: [
      {
        name,
        containers: [
          { name: 'vllm', image: `ghcr.io/super-protocol/demo-vllm@sha256:${sha256(hostname).toString('hex')}` },
          { name: 'litellm', image: `ghcr.io/super-protocol/demo-litellm:${tag}` },
        ],
      },
    ],
    measurements: {
      mrtd: sha256(`${hostname}/mrtd`).toString('hex'),
      rtmr0: sha256(`${hostname}/rtmr0`).toString('hex'),
      rtmr1: sha256(`${hostname}/rtmr1`).toString('hex'),
      rtmr2: sha256(`${hostname}/rtmr2`).toString('hex'),
    },
  };
}

/** Stable key order, so the same snapshot always hashes to the same digest. */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function signBundle(endpoint, rootPem) {
  const issuedAt = new Date().toISOString();
  const leaf = new X509Certificate(endpoint.certificate);
  const certFingerprint = `sha256/${base64url(sha256(leaf.raw))}`;
  const evidence = endpoint.snapshot;

  const payload = {
    version: '1',
    kind: 'DeploymentEvidence',
    hostname: endpoint.hostname,
    issuedAt,
    certFingerprint,
    evidenceDigest: `sha256/${base64url(sha256(canonicalJson(evidence)))}`,
    evidence,
  };

  const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(endpoint.privateKey);

  return {
    version: '1',
    kind: 'DeploymentEvidence',
    hostname: endpoint.hostname,
    issuedAt,
    certFingerprint,
    jws: `${signingInput}.${base64url(signature)}`,
    certChain: [endpoint.certificate, rootPem],
    rootCaTeeQuote: {
      // Deliberately not a real quote format: nothing should mistake this for
      // attestable evidence.
      format: 'mock-demo-quote-v0',
      data: base64url(sha256(`${endpoint.hostname}/quote`)),
      collateral: { measurements: evidence.measurements },
    },
    tlsLeaf: endpoint.certificate,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

mkdirSync(PKI_DIR, { recursive: true });
const rootPem = createRoot();
const endpoints = new Map();
for (const [name, hostname] of parseEndpoints(process.env.EVIDENCE_ENDPOINTS)) {
  endpoints.set(name, { name, hostname, snapshot: snapshotFor(name, hostname), ...createLeaf(name, hostname) });
}

let bundles = new Map();
function reissue() {
  bundles = new Map([...endpoints].map(([name, endpoint]) => [name, signBundle(endpoint, rootPem)]));
}
reissue();
setInterval(reissue, REISSUE_MS).unref();

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body, null, 2));
};

const server = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];

  if (path === '/health') {
    json(response, 200, { status: 'ok', endpoints: [...endpoints.keys()] });
    return;
  }
  if (path === ROOT_PATH) {
    response.writeHead(200, { 'content-type': 'application/x-pem-file' });
    response.end(rootPem);
    return;
  }
  if (path === '/') {
    json(response, 200, {
      note: 'Mock evidence publisher — the bundles here attest nothing.',
      root: ROOT_PATH,
      endpoints: [...endpoints.values()].map(({ name, hostname }) => ({
        name,
        hostname,
        evidence: `/${name}${EVIDENCE_PATH}`,
      })),
    });
    return;
  }
  if (path.endsWith(EVIDENCE_PATH)) {
    const name = path.slice(1, -EVIDENCE_PATH.length);
    const bundle = bundles.get(name);
    if (bundle) {
      json(response, 200, bundle);
      return;
    }
  }
  json(response, 404, { error: `no evidence published at ${path}` });
});

server.listen(PORT, HOST, () => {
  console.log(`[evidence-publisher] listening on http://${HOST}:${PORT}`);
  for (const { name, hostname } of endpoints.values()) {
    console.log(`[evidence-publisher]   /${name}${EVIDENCE_PATH} → ${hostname}`);
  }
  console.log(`[evidence-publisher] demo root CA: ${ROOT_PATH} (re-signing every ${REISSUE_MS}ms)`);
});
