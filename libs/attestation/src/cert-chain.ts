/**
 * X.509 chain validation, leaf → root.
 *
 * Ported from Super-Protocol/swarm-cloud `libs/swarm-attestation/src/cert-chain.ts`
 * (BSL-1.1) with permission; see the repository NOTICE.
 */
import { BasicConstraintsExtension, KeyUsageFlags, KeyUsagesExtension, X509Certificate } from '@peculiar/x509';
import { extractTbsCertificate, isSecp256k1Cert, verifySecp256k1 } from './crypto-secp256k1.js';
import { sha256Fingerprint } from './fingerprint.js';

export class CertChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertChainError';
  }
}

export interface ParsedChain {
  certs: X509Certificate[];
  leaf: X509Certificate;
  root: X509Certificate;
  rootFingerprint: string;
}

export interface ValidateChainOptions {
  now?: Date;
}

export function parseCertificates(pems: string[]): X509Certificate[] {
  if (!Array.isArray(pems) || pems.length === 0) {
    throw new CertChainError('certChain must contain at least one certificate');
  }
  return pems.map((pem, i) => {
    try {
      return new X509Certificate(pem);
    } catch (err) {
      throw new CertChainError(`failed to parse certificate at index ${i}: ${(err as Error).message}`);
    }
  });
}

/**
 * Verifies the child cert's signature against the parent's public key.
 *
 * RSA goes through Web Crypto via `@peculiar/x509`. secp256k1 (ECDSA K-256) always
 * goes through the bundled pure-JS verifier: no runtime we target exposes K-256 on
 * `crypto.subtle` consistently, and — unlike the swarm-cloud original, which only
 * fell back when `verify()` *threw* — Node's native Web Crypto makes `verify()`
 * return a plain `false` for an unrecognised curve. Trying subtle first would
 * therefore reject valid ES256K chains outright. See README, "Deviations from the
 * source".
 */
async function verifyChildAgainstParent(child: X509Certificate, parent: X509Certificate): Promise<boolean> {
  if (isSecp256k1Cert(parent)) {
    try {
      const tbs = extractTbsCertificate(new Uint8Array(child.rawData));
      return verifySecp256k1(new Uint8Array(child.signature), tbs, new Uint8Array(parent.publicKey.rawData));
    } catch (err) {
      throw new CertChainError(`secp256k1 verification raised: ${(err as Error).message}`);
    }
  }

  try {
    return await child.verify({ publicKey: parent.publicKey, signatureOnly: true });
  } catch (err) {
    throw new CertChainError(`signature verification raised: ${(err as Error).message}`);
  }
}

function assertIssuerHygiene(certs: X509Certificate[]): void {
  // Enforce X.509 issuer hygiene on every non-leaf certificate. Without these checks a
  // malformed chain (e.g. a leaf claiming itself as issuer, or an EE cert acting as a CA)
  // would pass on issuer-name + signature alone. The CA-bit is the baseline guarantee
  // that the certifying authority is authorised to issue subordinate certs at all.
  for (let i = 1; i < certs.length; i++) {
    const issuer = certs[i] as X509Certificate;
    const bc = issuer.getExtension(BasicConstraintsExtension);
    if (!bc?.ca) {
      throw new CertChainError(
        `certificate at index ${i} ("${issuer.subject}") is not a CA (BasicConstraints.cA missing or false)`,
      );
    }
    const intermediatesBelow = i - 1;
    if (typeof bc.pathLength === 'number' && bc.pathLength < intermediatesBelow) {
      throw new CertChainError(
        `pathLenConstraint=${bc.pathLength} on "${issuer.subject}" is exceeded by chain depth ${intermediatesBelow}`,
      );
    }
    const ku = issuer.getExtension(KeyUsagesExtension);
    if (ku && (ku.usages & KeyUsageFlags.keyCertSign) === 0) {
      throw new CertChainError(
        `certificate at index ${i} ("${issuer.subject}") does not assert keyCertSign in KeyUsage`,
      );
    }
  }
}

export async function validateChain(pems: string[], options: ValidateChainOptions = {}): Promise<ParsedChain> {
  const certs = parseCertificates(pems);
  const now = options.now ?? new Date();

  for (const cert of certs) {
    if (cert.notBefore.getTime() > now.getTime()) {
      throw new CertChainError(`certificate "${cert.subject}" is not yet valid`);
    }
    if (cert.notAfter.getTime() < now.getTime()) {
      throw new CertChainError(`certificate "${cert.subject}" has expired`);
    }
  }

  assertIssuerHygiene(certs);

  for (let i = 0; i < certs.length - 1; i++) {
    const child = certs[i] as X509Certificate;
    const parent = certs[i + 1] as X509Certificate;
    if (child.issuer !== parent.subject) {
      throw new CertChainError(
        `certificate at index ${i} ("${child.subject}") issuer does not match next certificate's subject`,
      );
    }
    const ok = await verifyChildAgainstParent(child, parent);
    if (!ok) {
      throw new CertChainError(`signature verification failed for certificate at index ${i} ("${child.subject}")`);
    }
  }

  const root = certs[certs.length - 1] as X509Certificate;
  if (root.issuer !== root.subject) {
    throw new CertChainError('chain does not terminate at a self-signed root certificate');
  }
  const rootSelfOk = await verifyChildAgainstParent(root, root);
  if (!rootSelfOk) {
    throw new CertChainError('root self-signature is invalid');
  }

  const rootFingerprint = await sha256Fingerprint(new Uint8Array(root.rawData));

  return {
    certs,
    leaf: certs[0] as X509Certificate,
    root,
    rootFingerprint,
  };
}

export async function rootFingerprintFromPem(pem: string): Promise<string> {
  const cert = new X509Certificate(pem);
  return sha256Fingerprint(new Uint8Array(cert.rawData));
}
