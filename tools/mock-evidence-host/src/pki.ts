/**
 * The certificate authorities `tools/mock-evidence-host` terminates TLS with.
 *
 * Two independent RSA PKIs, each root → intermediate → leaf, built from the key
 * material in `@confidential-router/attestation-fixtures`. The keys are the
 * fixtures'; the certificates are *not* — they are minted here with a validity
 * window centred on now.
 *
 * That split is deliberate. The committed vectors are frozen in time (every
 * case pins `now: 2026-01-15` and the certificates expire on 2027-01-01), which
 * is exactly right for a conformance suite and useless for a live endpoint: a
 * gatekeeper checks the chain against the real clock, so a server presenting
 * those certificates would start failing on a date nobody chose. Re-issuing
 * from the same keys keeps the material the repository already reviews and
 * removes the expiry cliff.
 *
 * Nothing here attests anything. The "TEE quote" the host publishes is a
 * fixture blob and the root is minted in-process.
 */
import { createHash, webcrypto } from 'node:crypto';
import { type FixtureKeyName, loadFixtureKey } from '@confidential-router/attestation-fixtures';
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509CertificateGenerator,
} from '@peculiar/x509';

/**
 * Node's own Web Crypto, and deliberately not `@peculiar/webcrypto`.
 *
 * `@peculiar/x509` signs through whatever `cryptoProvider` holds, and the
 * verifier this mock is checked against exports the leaf's public key the same
 * way before handing it to `jose`, which verifies with `globalThis.crypto`.
 * Installing a second Web Crypto implementation makes those two halves disagree
 * about what a CryptoKey is, and every signature fails to verify for no visible
 * reason. One implementation, end to end.
 */
const crypto = webcrypto as unknown as Crypto;

const RSA_ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

/** Roots and intermediates outlive any run; a leaf is short-lived on purpose. */
const CA_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const LEAF_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** Backdated so a clock a few seconds behind the mock still accepts the leaf. */
const BACKDATE_MS = 60 * 60 * 1000;

export interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export interface IssuedCertificate {
  pem: string;
  der: Uint8Array;
  /** `sha256/<base64url>` of the DER — what a verifier matches on. */
  fingerprint: string;
  privateKey: CryptoKey;
  /** PKCS#8 PEM of the private key, for Node's TLS server. */
  privateKeyPem: string;
}

/** One root → intermediate → leaf issuing path. */
export interface Authority {
  name: string;
  root: IssuedCertificate;
  intermediate: IssuedCertificate;
  /** Issues a fresh server leaf for `hostname`, valid from now. */
  issueLeaf(hostname: string): Promise<IssuedCertificate>;
}

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function sha256(input: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}

export function fingerprintOf(der: Uint8Array): string {
  return `sha256/${base64Url(sha256(der))}`;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(body, 'base64'));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function loadKeyPair(name: FixtureKeyName): Promise<{ keys: KeyPair; pem: string }> {
  const pem = loadFixtureKey(name);
  const privateKey = await crypto.subtle.importKey('pkcs8', toArrayBuffer(pemToDer(pem)), RSA_ALG, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKey = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true }, RSA_ALG, true, [
    'verify',
  ]);
  return { keys: { privateKey, publicKey }, pem };
}

interface IssueSpec {
  serial: string;
  subject: string;
  keys: KeyPair;
  privateKeyPem: string;
  lifetimeMs: number;
  issuer?: { cert: X509Certificate; privateKey: CryptoKey };
  extensions: unknown[];
}

async function issue(spec: IssueSpec): Promise<{ issued: IssuedCertificate; cert: X509Certificate }> {
  const notBefore = new Date(Date.now() - BACKDATE_MS);
  const notAfter = new Date(Date.now() + spec.lifetimeMs);
  const common = {
    serialNumber: spec.serial,
    notBefore,
    notAfter,
    signingAlgorithm: RSA_ALG,
    extensions: spec.extensions as never[],
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

  const der = new Uint8Array(cert.rawData);
  return {
    cert,
    issued: {
      pem: cert.toString('pem'),
      der,
      fingerprint: fingerprintOf(der),
      privateKey: spec.keys.privateKey,
      privateKeyPem: spec.privateKeyPem,
    },
  };
}

function caExtensions(pathLength?: number): unknown[] {
  return [
    new BasicConstraintsExtension(true, pathLength, true),
    new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
  ];
}

function leafExtensions(hostname: string): unknown[] {
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  return [
    new BasicConstraintsExtension(false),
    new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true),
    new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']),
    new SubjectAlternativeNameExtension([{ type: isIp ? 'ip' : 'dns', value: hostname }]),
  ];
}

export interface AuthoritySpec {
  name: string;
  rootKey: FixtureKeyName;
  intermediateKey: FixtureKeyName;
  leafKey: FixtureKeyName;
  /** Serial prefix, so two authorities in one process never collide. */
  serialBase: number;
}

/** Builds one root → intermediate pair and a leaf issuer over it. */
export async function buildAuthority(spec: AuthoritySpec): Promise<Authority> {
  const rootKeys = await loadKeyPair(spec.rootKey);
  const intermediateKeys = await loadKeyPair(spec.intermediateKey);
  const leafKeys = await loadKeyPair(spec.leafKey);

  const root = await issue({
    serial: (spec.serialBase + 1).toString(16).padStart(2, '0'),
    subject: `CN=${spec.name}-root`,
    keys: rootKeys.keys,
    privateKeyPem: rootKeys.pem,
    lifetimeMs: CA_LIFETIME_MS,
    extensions: caExtensions(),
  });
  const intermediate = await issue({
    serial: (spec.serialBase + 2).toString(16).padStart(2, '0'),
    subject: `CN=${spec.name}-intermediate`,
    keys: intermediateKeys.keys,
    privateKeyPem: intermediateKeys.pem,
    lifetimeMs: CA_LIFETIME_MS,
    issuer: { cert: root.cert, privateKey: rootKeys.keys.privateKey },
    extensions: caExtensions(0),
  });

  // Serials have to differ across the leaves one authority issues over a run:
  // rotating the certificate mints another one while the old is still valid.
  let leafSerial = spec.serialBase + 3;

  return {
    name: spec.name,
    root: root.issued,
    intermediate: intermediate.issued,
    async issueLeaf(hostname: string): Promise<IssuedCertificate> {
      leafSerial += 1;
      const leaf = await issue({
        serial: leafSerial.toString(16).padStart(2, '0'),
        subject: `CN=${hostname}`,
        keys: leafKeys.keys,
        privateKeyPem: leafKeys.pem,
        lifetimeMs: LEAF_LIFETIME_MS,
        issuer: { cert: intermediate.cert, privateKey: intermediateKeys.keys.privateKey },
        extensions: leafExtensions(hostname),
      });
      return leaf.issued;
    },
  };
}

/** The authority a gatekeeper is meant to trust, and the one it is not. */
export function trustedAuthoritySpec(): AuthoritySpec {
  return {
    name: 'confidential-router-mock',
    rootKey: 'rsa-root-a',
    intermediateKey: 'rsa-intermediate-a',
    leafKey: 'rsa-leaf-a',
    serialBase: 0x10,
  };
}

export function otherCloudAuthoritySpec(): AuthoritySpec {
  return {
    name: 'other-cloud-mock',
    rootKey: 'rsa-root-b',
    intermediateKey: 'rsa-intermediate-b',
    leafKey: 'rsa-leaf-b',
    serialBase: 0x30,
  };
}

/** RS256 over `<header>.<payload>`, as the evidence contract's JWS. */
export async function signCompactJws(payload: unknown, signingKey: CryptoKey): Promise<string> {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = new TextEncoder().encode(`${header}.${body}`);
  const signature = await crypto.subtle.sign(RSA_ALG, signingKey, signingInput);
  return `${header}.${body}.${base64Url(new Uint8Array(signature))}`;
}
