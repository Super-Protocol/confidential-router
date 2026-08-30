/**
 * Regenerates the language-neutral conformance vectors in `../vectors`.
 *
 *   pnpm nx run attestation-fixtures:generate
 *
 * The output is deterministic: the key material is fixed (`./keys`), so are the
 * serial numbers, certificate validity windows and every timestamp, and both
 * signature schemes used here are deterministic — RSASSA-PKCS1-v1_5 by
 * construction, secp256k1 because `@noble/curves` derives `k` per RFC 6979.
 * `crypto.subtle`'s own ECDSA is *not* deterministic, so EC signing is routed
 * through noble by the `deterministicSubtle` shim below. Running this script
 * twice produces byte-identical files; a non-empty `git diff` after a run means
 * a real change to the vectors.
 *
 * Structure and PKI helpers are ported from Super-Protocol/swarm-cloud
 * `libs/swarm-attestation/src/__tests__/fixtures.ts` (BSL-1.1) with permission;
 * see the repository NOTICE.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { Crypto as PeculiarCrypto } from '@peculiar/webcrypto';
import {
  BasicConstraintsExtension,
  cryptoProvider,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509CertificateGenerator,
} from '@peculiar/x509';
import { CompactSign } from 'jose';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(HERE, 'keys');
const VECTORS_DIR = join(HERE, '..', 'vectors');
const BUNDLES_DIR = join(VECTORS_DIR, 'bundles');

const HOSTNAME = 'router.example.test';
const OTHER_HOSTNAME = 'other.example.test';

/** Every case is evaluated at this instant unless it overrides `now`. */
const REFERENCE_NOW = '2026-01-15T12:00:00.000Z';
const FRESH_ISSUED_AT = '2026-01-15T11:55:00.000Z';
const STALE_ISSUED_AT = '2026-01-10T12:00:00.000Z';
const FUTURE_ISSUED_AT = '2026-01-15T12:30:00.000Z';
const MAX_BUNDLE_AGE_MS = 24 * 60 * 60 * 1000;

const VALID_FROM = new Date('2026-01-01T00:00:00.000Z');
const VALID_TO = new Date('2027-01-01T00:00:00.000Z');
const EXPIRED_FROM = new Date('2025-01-01T00:00:00.000Z');
const EXPIRED_TO = new Date('2025-06-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Deterministic Web Crypto
// ---------------------------------------------------------------------------

const peculiar = new PeculiarCrypto();
const rawSubtle = peculiar.subtle;

/** Private scalars of the secp256k1 keys, keyed by the CryptoKey handed to `sign`. */
const ecScalars = new Map<CryptoKey, Uint8Array>();

async function deterministicSign(algorithm: unknown, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
  const scalar = ecScalars.get(key);
  if (!scalar) {
    return rawSubtle.sign(algorithm as AlgorithmIdentifier, key, data);
  }
  const alg = algorithm as { name?: string; hash?: string | { name?: string } };
  const hashName = typeof alg.hash === 'string' ? alg.hash : alg.hash?.name;
  if (alg.name !== 'ECDSA' || hashName !== 'SHA-256') {
    throw new Error(`deterministic signer only handles ECDSA/SHA-256, got ${alg.name}/${hashName}`);
  }
  // WebCrypto's ECDSA signature format is raw r||s; @peculiar/x509 re-encodes it as
  // the DER SEQUENCE the certificate needs.
  const signature = secp256k1.sign(sha256(toBytes(data)), scalar).toBytes('compact');
  return toArrayBuffer(signature);
}

const deterministicSubtle = new Proxy(rawSubtle, {
  get(target, prop) {
    if (prop === 'sign') return deterministicSign;
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as SubtleCrypto;

const cryptoShim = {
  getRandomValues: peculiar.getRandomValues.bind(peculiar),
  subtle: deterministicSubtle,
} as unknown as Crypto;

cryptoProvider.set(cryptoShim);
Object.defineProperty(globalThis, 'crypto', { value: cryptoShim, writable: true, configurable: true });

// ---------------------------------------------------------------------------
// Small encoding helpers (deliberately not imported from @confidential-router/attestation —
// the vectors must be derived independently of the implementation they pin)
// ---------------------------------------------------------------------------

function toBytes(data: BufferSource): Uint8Array {
  return data instanceof Uint8Array
    ? data
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function base64UrlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function sha256Fingerprint(bytes: Uint8Array): string {
  return `sha256/${base64UrlEncode(sha256(bytes))}`;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(body, 'base64'));
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

const RSA_ALG: RsaHashedImportParams & { hash: string } = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const EC_ALG: EcKeyImportParams & { hash: string } = { name: 'ECDSA', namedCurve: 'K-256', hash: 'SHA-256' };

interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

async function loadKeyPair(name: string): Promise<KeyPair> {
  const isEc = name.startsWith('ec-');
  const algorithm = isEc ? EC_ALG : RSA_ALG;
  const der = pemToDer(readFileSync(join(KEYS_DIR, `${name}.key.pem`), 'utf8'));
  const privateKey = await deterministicSubtle.importKey('pkcs8', toArrayBuffer(der), algorithm, true, ['sign']);
  const jwk = (await deterministicSubtle.exportKey('jwk', privateKey)) as JsonWebKey & { d?: string };
  const publicJwk: JsonWebKey = isEc
    ? { kty: 'EC', crv: 'K-256', x: jwk.x, y: jwk.y, ext: true }
    : { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true };
  const publicKey = await deterministicSubtle.importKey('jwk', publicJwk, algorithm, true, ['verify']);
  if (isEc) {
    if (typeof jwk.d !== 'string') throw new Error(`EC key ${name} exported without a private scalar`);
    ecScalars.set(privateKey, base64UrlDecode(jwk.d));
  }
  return { privateKey, publicKey };
}

// ---------------------------------------------------------------------------
// Certificate issuance
// ---------------------------------------------------------------------------

interface IssuedCert extends KeyPair {
  cert: X509Certificate;
  pem: string;
  fingerprint: string;
}

interface CertSpec {
  serial: string;
  subject: string;
  keys: KeyPair;
  notBefore?: Date;
  notAfter?: Date;
  /** Omitted for a self-signed root. */
  issuer?: IssuedCert;
  extensions: Extension[];
}

type Extension =
  | BasicConstraintsExtension
  | KeyUsagesExtension
  | ExtendedKeyUsageExtension
  | SubjectAlternativeNameExtension;

function caExtensions(pathLength?: number): Extension[] {
  return [
    new BasicConstraintsExtension(true, pathLength, true),
    new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
  ];
}

function leafExtensions(hostname: string): Extension[] {
  return [
    new BasicConstraintsExtension(false),
    new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true),
    new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']),
    new SubjectAlternativeNameExtension([{ type: 'dns', value: hostname }]),
  ];
}

async function issue(spec: CertSpec): Promise<IssuedCert> {
  const signingKey = spec.issuer ? spec.issuer.privateKey : spec.keys.privateKey;
  const signingAlgorithm = ecScalars.has(signingKey) ? EC_ALG : RSA_ALG;
  const common = {
    serialNumber: spec.serial,
    notBefore: spec.notBefore ?? VALID_FROM,
    notAfter: spec.notAfter ?? VALID_TO,
    signingAlgorithm,
    extensions: spec.extensions,
  };
  const cert = spec.issuer
    ? await X509CertificateGenerator.create({
        ...common,
        subject: spec.subject,
        issuer: spec.issuer.cert.subject,
        publicKey: spec.keys.publicKey,
        signingKey: spec.issuer.privateKey,
      })
    : await X509CertificateGenerator.createSelfSigned({
        ...common,
        name: spec.subject,
        keys: { privateKey: spec.keys.privateKey, publicKey: spec.keys.publicKey },
      });
  const raw = new Uint8Array(cert.rawData);
  return {
    ...spec.keys,
    cert,
    pem: cert.toString('pem'),
    fingerprint: sha256Fingerprint(raw),
  };
}

// ---------------------------------------------------------------------------
// Evidence payloads and bundles
// ---------------------------------------------------------------------------

type EvidenceKind = 'DeploymentEvidence' | 'ControlPlaneEvidence' | 'KubernetesControlPlaneEvidence';

const DEPLOYMENT_SNAPSHOT = {
  version: 2,
  resources: [
    {
      kind: 'Deployment',
      name: 'router-api',
      namespace: 'confidential-router',
      containers: [
        {
          name: 'router-api',
          image:
            'ghcr.io/super-protocol/router-api@sha256:1111111111111111111111111111111111111111111111111111111111111111',
        },
      ],
    },
    {
      kind: 'Deployment',
      name: 'litellm',
      namespace: 'confidential-router',
      containers: [
        {
          name: 'litellm',
          image: 'ghcr.io/berriai/litellm@sha256:2222222222222222222222222222222222222222222222222222222222222222',
        },
      ],
    },
  ],
} as const;

/** The value a gatekeeper user pins — sha256 of the canonical snapshot JSON. */
const EVIDENCE_DIGEST = sha256Fingerprint(new TextEncoder().encode(JSON.stringify(DEPLOYMENT_SNAPSHOT)));

interface PayloadOptions {
  kind: EvidenceKind;
  hostname?: string;
  issuedAt?: string;
  certFingerprint: string;
}

function buildPayload(options: PayloadOptions): Record<string, unknown> {
  const base = {
    version: '1',
    hostname: options.hostname ?? HOSTNAME,
    issuedAt: options.issuedAt ?? FRESH_ISSUED_AT,
    certFingerprint: options.certFingerprint,
  };
  switch (options.kind) {
    case 'DeploymentEvidence':
      return {
        ...base,
        kind: 'DeploymentEvidence',
        evidenceDigest: EVIDENCE_DIGEST,
        evidence: DEPLOYMENT_SNAPSHOT,
      };
    case 'ControlPlaneEvidence':
      return {
        ...base,
        kind: 'ControlPlaneEvidence',
        topologyDigest: sha256Fingerprint(new TextEncoder().encode('confidential-router-test-topology')),
      };
    case 'KubernetesControlPlaneEvidence':
      return {
        ...base,
        kind: 'KubernetesControlPlaneEvidence',
        rke2Version: 'v1.30.4+rke2r1',
        installHash: sha256Fingerprint(new TextEncoder().encode('confidential-router-test-install')),
        kubeSystemDigest: sha256Fingerprint(new TextEncoder().encode('confidential-router-test-kube-system')),
      };
  }
}

async function signCompactJws(payload: string, alg: 'RS256' | 'ES256K', signer: IssuedCert): Promise<string> {
  if (alg === 'RS256') {
    return new CompactSign(new TextEncoder().encode(payload)).setProtectedHeader({ alg }).sign(signer.privateKey);
  }
  // jose v6 expects the Node-native `secp256k1` namedCurve while @peculiar/webcrypto
  // reports `K-256`, so ES256K is signed directly with noble. The verifier's own
  // secp256k1 fallback consumes exactly this shape.
  const scalar = ecScalars.get(signer.privateKey);
  if (!scalar) throw new Error('ES256K signing requires a secp256k1 key');
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg })));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = secp256k1.sign(sha256(signingInput), scalar).toBytes('compact');
  return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}

interface BundleOptions {
  kind?: EvidenceKind;
  hostname?: string;
  chain: IssuedCert[];
  /** Defaults to the chain leaf. */
  signer?: IssuedCert;
  alg?: 'RS256' | 'ES256K';
  issuedAt?: string;
  /** Fingerprint embedded in the signed payload. Defaults to the chain leaf's. */
  payloadCertFingerprint?: string;
  payloadHostname?: string;
  tlsLeaf?: IssuedCert;
  rootCaTeeQuote?: Record<string, unknown>;
  /** Applied to the finished document — used to forge malformed bundles. */
  tamper?: (bundle: Record<string, unknown>) => Record<string, unknown>;
}

async function buildBundle(options: BundleOptions): Promise<Record<string, unknown>> {
  const leaf = options.chain[0] as IssuedCert;
  const signer = options.signer ?? leaf;
  const alg = options.alg ?? (ecScalars.has(signer.privateKey) ? 'ES256K' : 'RS256');
  const kind = options.kind ?? 'DeploymentEvidence';
  const certFingerprint = options.payloadCertFingerprint ?? (options.tlsLeaf ?? leaf).fingerprint;
  const payload = buildPayload({
    kind,
    hostname: options.payloadHostname,
    issuedAt: options.issuedAt,
    certFingerprint,
  });
  const jws = await signCompactJws(JSON.stringify(payload), alg, signer);
  const bundle: Record<string, unknown> = {
    version: '1',
    kind,
    hostname: options.hostname ?? HOSTNAME,
    issuedAt: payload.issuedAt,
    certFingerprint,
    jws,
    certChain: options.chain.map((c) => c.pem),
  };
  if (options.rootCaTeeQuote) bundle.rootCaTeeQuote = options.rootCaTeeQuote;
  if (options.tlsLeaf) bundle.tlsLeaf = options.tlsLeaf.pem;
  return options.tamper ? options.tamper(bundle) : bundle;
}

/** Flips the last byte of the JWS signature, leaving a structurally valid compact JWS. */
function corruptJwsSignature(jws: string): string {
  const [header, payload, signature] = jws.split('.') as [string, string, string];
  const bytes = base64UrlDecode(signature);
  const last = bytes.length - 1;
  bytes[last] = (bytes[last] as number) ^ 0xff;
  return `${header}.${payload}.${base64UrlEncode(bytes)}`;
}

// ---------------------------------------------------------------------------
// The vectors
// ---------------------------------------------------------------------------

interface CaseRequest {
  hostname: string;
  trustedRoots: string[];
  observedTlsFingerprint?: string;
  now: string;
  maxBundleAge?: number;
}

interface CaseResponse {
  status: number;
  bodyFile?: string;
  bodyText?: string;
}

type CaseExpectation =
  | {
      ok: true;
      kind: EvidenceKind;
      channelBinding: 'observed' | 'producer-asserted';
      matchedRoot: string;
      payload: Record<string, unknown>;
      rootCaTeeQuote?: Record<string, unknown>;
    }
  | {
      ok: false;
      stage: 'fetch' | 'cert-chain' | 'untrusted-root' | 'jws' | 'tls-fingerprint';
      reasonContains: string;
    };

interface ConformanceCase {
  id: string;
  description: string;
  request: CaseRequest;
  response: CaseResponse;
  expect: CaseExpectation;
}

const TEE_QUOTE = {
  format: 'intel-tdx-quote-v5',
  data: base64UrlEncode(new TextEncoder().encode('confidential-router-test-tdx-quote')),
} as const;

const ROOT_RSA = 'confidential-router-test-root-rsa';
const ROOT_EC = 'confidential-router-test-root-ec';
const ROOT_OTHER = 'other-cloud-root-rsa';

async function main(): Promise<void> {
  // --- PKI ---------------------------------------------------------------
  const keys = {
    rootA: await loadKeyPair('rsa-root-a'),
    intA: await loadKeyPair('rsa-intermediate-a'),
    leafA: await loadKeyPair('rsa-leaf-a'),
    rootB: await loadKeyPair('rsa-root-b'),
    intB: await loadKeyPair('rsa-intermediate-b'),
    leafB: await loadKeyPair('rsa-leaf-b'),
    tlsLeaf: await loadKeyPair('rsa-tls-leaf'),
    ecRoot: await loadKeyPair('ec-root'),
    ecInt: await loadKeyPair('ec-intermediate'),
    ecLeaf: await loadKeyPair('ec-leaf'),
  };

  const rootA = await issue({ serial: '01', subject: `CN=${ROOT_RSA}`, keys: keys.rootA, extensions: caExtensions() });
  const intA = await issue({
    serial: '02',
    subject: 'CN=confidential-router-test-intermediate-rsa',
    keys: keys.intA,
    issuer: rootA,
    extensions: caExtensions(0),
  });
  const leafA = await issue({
    serial: '03',
    subject: `CN=${HOSTNAME}`,
    keys: keys.leafA,
    issuer: intA,
    extensions: leafExtensions(HOSTNAME),
  });

  const rootB = await issue({
    serial: '11',
    subject: `CN=${ROOT_OTHER}`,
    keys: keys.rootB,
    extensions: caExtensions(),
  });
  const intB = await issue({
    serial: '12',
    subject: 'CN=other-cloud-intermediate-rsa',
    keys: keys.intB,
    issuer: rootB,
    extensions: caExtensions(0),
  });
  const leafB = await issue({
    serial: '13',
    subject: `CN=${HOSTNAME}`,
    keys: keys.leafB,
    issuer: intB,
    extensions: leafExtensions(HOSTNAME),
  });

  const ecRoot = await issue({ serial: '21', subject: `CN=${ROOT_EC}`, keys: keys.ecRoot, extensions: caExtensions() });
  const ecInt = await issue({
    serial: '22',
    subject: 'CN=confidential-router-test-intermediate-ec',
    keys: keys.ecInt,
    issuer: ecRoot,
    extensions: caExtensions(0),
  });
  const ecLeaf = await issue({
    serial: '23',
    subject: `CN=${HOSTNAME}`,
    keys: keys.ecLeaf,
    issuer: ecInt,
    extensions: leafExtensions(HOSTNAME),
  });

  // The TLS-terminating leaf of the producer-asserted mode is issued by an unrelated
  // CA — in production it is an auto-ssl leaf from a public CA, not the evidence PKI.
  const tlsLeaf = await issue({
    serial: '31',
    subject: `CN=${HOSTNAME}`,
    keys: keys.tlsLeaf,
    issuer: intB,
    extensions: leafExtensions(HOSTNAME),
  });

  // Same subject and key as `intA`, but without the CA bit: the chain still verifies
  // signature-wise and must be rejected on issuer hygiene alone.
  const intANonCa = await issue({
    serial: '04',
    subject: 'CN=confidential-router-test-intermediate-rsa',
    keys: keys.intA,
    issuer: rootA,
    extensions: [new BasicConstraintsExtension(false)],
  });

  const leafAExpired = await issue({
    serial: '05',
    subject: `CN=${HOSTNAME}`,
    keys: keys.leafA,
    issuer: intA,
    notBefore: EXPIRED_FROM,
    notAfter: EXPIRED_TO,
    extensions: leafExtensions(HOSTNAME),
  });

  const chainA = [leafA, intA, rootA];
  const chainB = [leafB, intB, rootB];
  const chainEc = [ecLeaf, ecInt, ecRoot];

  // --- Cases -------------------------------------------------------------
  const cases: ConformanceCase[] = [];
  const bundles = new Map<string, unknown>();

  const observed = (fingerprint: string) => ({
    hostname: HOSTNAME,
    trustedRoots: [ROOT_RSA],
    observedTlsFingerprint: fingerprint,
    now: REFERENCE_NOW,
    maxBundleAge: MAX_BUNDLE_AGE_MS,
  });

  /** Registers a case whose evidence endpoint answers 200 with `body` as its JSON document. */
  function addCase(spec: Omit<ConformanceCase, 'response'> & { body: unknown }) {
    const { body, ...rest } = spec;
    bundles.set(spec.id, body);
    cases.push({ ...rest, response: { status: 200, bodyFile: `bundles/${spec.id}.json` } });
  }

  const okExpect = (spec: {
    kind: EvidenceKind;
    payload: Record<string, unknown>;
    channelBinding: 'observed' | 'producer-asserted';
    matchedRoot: string;
  }): CaseExpectation => ({ ok: true, ...spec });

  // 1. Happy paths, one per evidence kind, plus the TEE quote pass-through.
  const KIND_SLUGS: Record<EvidenceKind, string> = {
    DeploymentEvidence: 'deployment',
    ControlPlaneEvidence: 'control-plane',
    KubernetesControlPlaneEvidence: 'kubernetes-control-plane',
  };
  for (const kind of Object.keys(KIND_SLUGS) as EvidenceKind[]) {
    const id = `valid-rsa-${KIND_SLUGS[kind]}`;
    const withQuote = kind === 'DeploymentEvidence';
    const bundle = await buildBundle({
      kind,
      chain: chainA,
      rootCaTeeQuote: withQuote ? { ...TEE_QUOTE } : undefined,
    });
    const expectation = okExpect({
      kind,
      payload: buildPayload({ kind, certFingerprint: leafA.fingerprint }),
      channelBinding: 'observed',
      matchedRoot: ROOT_RSA,
    });
    if (withQuote && expectation.ok) expectation.rootCaTeeQuote = { ...TEE_QUOTE };
    addCase({
      id,
      description: `RS256 ${kind} bundle over a valid chain, live observed TLS binding${withQuote ? '; rootCaTeeQuote is passed through unverified' : ''}.`,
      request: observed(leafA.fingerprint),
      expect: expectation,
      body: bundle,
    });
  }

  addCase({
    id: 'valid-ec-deployment',
    description: 'ES256K DeploymentEvidence over a secp256k1 chain, live observed TLS binding.',
    request: { ...observed(ecLeaf.fingerprint), trustedRoots: [ROOT_EC] },
    expect: okExpect({
      kind: 'DeploymentEvidence',
      payload: buildPayload({ kind: 'DeploymentEvidence', certFingerprint: ecLeaf.fingerprint }),
      channelBinding: 'observed',
      matchedRoot: ROOT_EC,
    }),
    body: await buildBundle({ chain: chainEc }),
  });

  addCase({
    id: 'valid-producer-asserted',
    description:
      'No observed fingerprint: the binding falls back to hashing bundle.tlsLeaf, which is an unrelated TLS leaf.',
    request: { hostname: HOSTNAME, trustedRoots: [ROOT_RSA], now: REFERENCE_NOW, maxBundleAge: MAX_BUNDLE_AGE_MS },
    expect: okExpect({
      kind: 'DeploymentEvidence',
      payload: buildPayload({ kind: 'DeploymentEvidence', certFingerprint: tlsLeaf.fingerprint }),
      channelBinding: 'producer-asserted',
      matchedRoot: ROOT_RSA,
    }),
    body: await buildBundle({ chain: chainA, tlsLeaf }),
  });

  addCase({
    id: 'valid-without-max-bundle-age',
    description: 'maxBundleAge omitted disables the freshness stage entirely — a five-day-old bundle still verifies.',
    request: {
      hostname: HOSTNAME,
      trustedRoots: [ROOT_RSA],
      observedTlsFingerprint: leafA.fingerprint,
      now: REFERENCE_NOW,
    },
    expect: okExpect({
      kind: 'DeploymentEvidence',
      payload: buildPayload({
        kind: 'DeploymentEvidence',
        issuedAt: STALE_ISSUED_AT,
        certFingerprint: leafA.fingerprint,
      }),
      channelBinding: 'observed',
      matchedRoot: ROOT_RSA,
    }),
    body: await buildBundle({ chain: chainA, issuedAt: STALE_ISSUED_AT }),
  });

  // 2. fetch stage.
  cases.push({
    id: 'fetch-http-503',
    description: 'The evidence endpoint answers 503; nothing is parsed.',
    request: observed(leafA.fingerprint),
    response: { status: 503, bodyText: 'service unavailable' },
    expect: { ok: false, stage: 'fetch', reasonContains: 'unexpected status 503' },
  });
  cases.push({
    id: 'fetch-non-json-body',
    description: 'A 200 response whose body is not JSON (a captive-portal style interception).',
    request: observed(leafA.fingerprint),
    response: { status: 200, bodyText: '<html><body>not json</body></html>' },
    expect: { ok: false, stage: 'fetch', reasonContains: 'failed to parse response body as JSON' },
  });
  addCase({
    id: 'fetch-bundle-hostname-mismatch',
    description: 'The bundle is valid but was published for another hostname — a replay onto a different host.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'fetch', reasonContains: 'does not match request hostname' },
    body: await buildBundle({ chain: chainA, hostname: OTHER_HOSTNAME, payloadHostname: OTHER_HOSTNAME }),
  });
  addCase({
    id: 'fetch-unsupported-version',
    description: 'Unknown bundle version.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'fetch', reasonContains: 'unsupported bundle version' },
    body: await buildBundle({ chain: chainA, tamper: (b) => ({ ...b, version: '2' }) }),
  });
  addCase({
    id: 'fetch-unsupported-kind',
    description: 'Unknown evidence kind.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'fetch', reasonContains: 'unsupported bundle kind' },
    body: await buildBundle({ chain: chainA, tamper: (b) => ({ ...b, kind: 'SomethingElse' }) }),
  });
  addCase({
    id: 'fetch-missing-jws',
    description: 'Structurally incomplete bundle: no jws member.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'fetch', reasonContains: 'missing jws' },
    body: await buildBundle({
      chain: chainA,
      tamper: (b) => {
        const { jws: _jws, ...rest } = b;
        return rest;
      },
    }),
  });

  // 3. cert-chain stage.
  addCase({
    id: 'cert-chain-expired-leaf',
    description: 'The leaf certificate expired before `now`.',
    request: observed(leafAExpired.fingerprint),
    expect: { ok: false, stage: 'cert-chain', reasonContains: 'has expired' },
    body: await buildBundle({ chain: [leafAExpired, intA, rootA] }),
  });
  addCase({
    id: 'cert-chain-issuer-mismatch',
    description: "The chain splices a leaf onto another cloud's intermediate.",
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'cert-chain', reasonContains: 'issuer does not match' },
    body: await buildBundle({ chain: [leafA, intB, rootB] }),
  });
  addCase({
    id: 'cert-chain-non-ca-intermediate',
    description: 'The intermediate has the same subject and key as the real one but no BasicConstraints.cA.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'cert-chain', reasonContains: 'is not a CA' },
    body: await buildBundle({ chain: [leafA, intANonCa, rootA] }),
  });
  addCase({
    id: 'cert-chain-not-self-signed-root',
    description: 'The chain stops at the intermediate and never reaches a self-signed root.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'cert-chain', reasonContains: 'does not terminate at a self-signed root' },
    body: await buildBundle({ chain: [leafA, intA] }),
  });

  // 4. untrusted-root stage.
  addCase({
    id: 'untrusted-root-other-cloud',
    description: 'A well-formed chain from a cloud whose root is not in the trust store.',
    request: { ...observed(leafB.fingerprint), trustedRoots: [ROOT_RSA] },
    expect: { ok: false, stage: 'untrusted-root', reasonContains: 'not in trusted store' },
    body: await buildBundle({ chain: chainB }),
  });
  addCase({
    id: 'untrusted-root-wrong-anchor',
    description:
      'The store holds a valid root — just not this chain’s. Trust is matched by fingerprint, not by parseability.',
    request: { ...observed(leafA.fingerprint), trustedRoots: [ROOT_OTHER] },
    expect: { ok: false, stage: 'untrusted-root', reasonContains: 'not in trusted store' },
    body: await buildBundle({ chain: chainA }),
  });
  addCase({
    id: 'untrusted-root-empty-store',
    description: 'An empty trust store denies everything.',
    request: { ...observed(leafA.fingerprint), trustedRoots: [] },
    expect: { ok: false, stage: 'untrusted-root', reasonContains: 'not in trusted store' },
    body: await buildBundle({ chain: chainA }),
  });

  // 5. jws stage.
  addCase({
    id: 'jws-bad-signature',
    description: 'The JWS signature is bit-flipped; the chain itself is intact.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'jws', reasonContains: 'signature verification failed' },
    body: await buildBundle({ chain: chainA, tamper: (b) => ({ ...b, jws: corruptJwsSignature(b.jws as string) }) }),
  });
  addCase({
    id: 'jws-unsupported-alg',
    description: 'The protected header advertises an algorithm outside the allow-list.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'jws', reasonContains: 'unsupported JWS alg' },
    body: await buildBundle({
      chain: chainA,
      tamper: (b) => {
        const [, payload, signature] = (b.jws as string).split('.');
        const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256' })));
        return { ...b, jws: `${header}.${payload}.${signature}` };
      },
    }),
  });
  addCase({
    id: 'jws-payload-hostname-mismatch',
    description: 'The signed payload names a different hostname than the one being verified.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'jws', reasonContains: 'payload hostname' },
    body: await buildBundle({ chain: chainA, payloadHostname: OTHER_HOSTNAME }),
  });
  addCase({
    id: 'jws-payload-kind-mismatch',
    description: 'The bundle envelope claims a different kind than the signed payload.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'jws', reasonContains: 'does not match bundle kind' },
    body: await buildBundle({ chain: chainA, tamper: (b) => ({ ...b, kind: 'ControlPlaneEvidence' }) }),
  });
  addCase({
    id: 'jws-stale-bundle',
    description: 'The payload is five days old against a 24h maxBundleAge.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'jws', reasonContains: 'exceeds maxBundleAge' },
    body: await buildBundle({ chain: chainA, issuedAt: STALE_ISSUED_AT }),
  });
  addCase({
    id: 'jws-future-bundle',
    description: 'The payload is dated 30 minutes ahead, past the 60s clock-skew tolerance.',
    request: observed(leafA.fingerprint),
    expect: { ok: false, stage: 'jws', reasonContains: 'in the future' },
    body: await buildBundle({ chain: chainA, issuedAt: FUTURE_ISSUED_AT }),
  });

  // 6. tls-fingerprint stage.
  addCase({
    id: 'tls-fingerprint-observed-mismatch',
    description: 'The observed TLS leaf is not the one the payload commits to — a TLS-terminating man in the middle.',
    request: observed(leafB.fingerprint),
    expect: { ok: false, stage: 'tls-fingerprint', reasonContains: 'does not match observed' },
    body: await buildBundle({ chain: chainA }),
  });
  addCase({
    id: 'tls-fingerprint-no-binding',
    description: 'Neither an observed fingerprint nor bundle.tlsLeaf: the signature is unbound to any channel.',
    request: { hostname: HOSTNAME, trustedRoots: [ROOT_RSA], now: REFERENCE_NOW, maxBundleAge: MAX_BUNDLE_AGE_MS },
    expect: { ok: false, stage: 'tls-fingerprint', reasonContains: 'no observed fingerprint and no tlsLeaf' },
    body: await buildBundle({ chain: chainA }),
  });
  addCase({
    id: 'tls-fingerprint-producer-asserted-mismatch',
    description: 'bundle.tlsLeaf is published but hashes to something other than payload.certFingerprint.',
    request: { hostname: HOSTNAME, trustedRoots: [ROOT_RSA], now: REFERENCE_NOW, maxBundleAge: MAX_BUNDLE_AGE_MS },
    expect: { ok: false, stage: 'tls-fingerprint', reasonContains: 'does not match bundle.tlsLeaf fingerprint' },
    body: await buildBundle({ chain: chainA, tlsLeaf, payloadCertFingerprint: leafA.fingerprint }),
  });
  addCase({
    id: 'tls-fingerprint-malformed-observed',
    description:
      'The caller supplied a fingerprint that is not sha256/<base64url>; rejected before anything is fetched.',
    request: { ...observed(leafA.fingerprint), observedTlsFingerprint: 'deadbeef' },
    expect: { ok: false, stage: 'tls-fingerprint', reasonContains: 'must match sha256/<base64url>' },
    body: await buildBundle({ chain: chainA }),
  });

  // --- Write -------------------------------------------------------------
  rmSync(BUNDLES_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLES_DIR, { recursive: true });

  for (const [id, body] of bundles) {
    writeJson(join(BUNDLES_DIR, `${id}.json`), body);
  }

  writeJson(join(VECTORS_DIR, 'roots.json'), {
    version: '1',
    description:
      'Trust anchors referenced by manifest.json cases. `fingerprint` is sha256/<base64url> of the DER — the value a verifier matches on.',
    roots: [
      { name: ROOT_RSA, fingerprint: rootA.fingerprint, pem: rootA.pem },
      { name: ROOT_EC, fingerprint: ecRoot.fingerprint, pem: ecRoot.pem },
      { name: ROOT_OTHER, fingerprint: rootB.fingerprint, pem: rootB.pem },
    ],
  });

  writeJson(join(VECTORS_DIR, 'manifest.json'), {
    version: '1',
    description:
      'Conformance vectors for the /.well-known/swarm-evidence verifier. Every implementation (TypeScript libs/attestation, Go apps/gatekeeper/pkg/attestation) must reproduce every verdict.',
    generator: 'libs/attestation-fixtures/tools/generate.ts',
    referenceNow: REFERENCE_NOW,
    rootsFile: 'roots.json',
    cases,
  });

  writeJson(join(VECTORS_DIR, 'evidence-digest.json'), buildEvidenceDigestVectors());

  const bundleCount = bundles.size;
  process.stdout.write(`wrote ${cases.length} cases (${bundleCount} bundle documents) to ${VECTORS_DIR}\n`);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Vectors for the `evidenceDigest` parser (`@confidential-router/types`), so the Go
 * loader in `apps/gatekeeper/pkg/config` enforces the identical normalisation rules.
 */
function buildEvidenceDigestVectors() {
  const canonical = EVIDENCE_DIGEST;
  const encoded = canonical.slice('sha256/'.length);
  const hex = Buffer.from(encoded, 'base64url').toString('hex');
  // A 32-byte value occupies 258 bits of the 43 base64url characters, so the final
  // character must carry two trailing zero bits — anything else is a distinct string
  // that decodes to the same bytes and would defeat exact-string pin comparison.
  const nonCanonicalTail = `sha256/${encoded.slice(0, 42)}B`;

  return {
    version: '1',
    description:
      'Accepted encodings of a pinned evidenceDigest and their canonical form. `valid: false` means the parser must reject the input rather than normalise it.',
    canonicalFinalCharacters: 'AEIMQUYcgkosw048',
    cases: [
      { input: canonical, valid: true, canonical, note: 'canonical form is idempotent' },
      { input: `${canonical}=`, valid: true, canonical, note: 'base64url padding is stripped' },
      { input: `  ${canonical}  `, valid: true, canonical, note: 'surrounding whitespace is trimmed' },
      { input: hex, valid: true, canonical, note: 'bare lowercase hex' },
      { input: hex.toUpperCase(), valid: true, canonical, note: 'bare uppercase hex' },
      { input: `sha256/${hex}`, valid: true, canonical, note: 'prefixed hex' },
      { input: '', valid: false, note: 'empty string' },
      { input: 'sha256/', valid: false, note: 'prefix only' },
      { input: `sha256/${encoded.slice(0, 42)}`, valid: false, note: '42 characters is too short' },
      { input: `sha256/${encoded}A`, valid: false, note: '44 characters is too long' },
      { input: nonCanonicalTail, valid: false, note: 'final character carries non-zero trailing bits' },
      { input: `sha256/${'A'.repeat(41)}+A`, valid: false, note: 'standard base64 alphabet is not base64url' },
      { input: `sha256/${'A'.repeat(41)}/A`, valid: false, note: 'standard base64 alphabet is not base64url' },
      { input: hex.slice(0, 63), valid: false, note: '63 hex characters' },
      { input: `${hex}ab`, valid: false, note: '66 hex characters' },
      { input: `sha512/${encoded}`, valid: false, note: 'wrong hash algorithm prefix' },
      { input: encoded, valid: false, note: 'bare base64url without the sha256/ prefix' },
      { input: `sha256/${encoded.slice(0, 42)}$`, valid: false, note: 'illegal character' },
    ],
  };
}

await main();
