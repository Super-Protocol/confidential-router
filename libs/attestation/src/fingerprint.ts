/**
 * `sha256/<base64url>` certificate fingerprints.
 *
 * Ported from Super-Protocol/swarm-cloud `libs/swarm-attestation/src/fingerprint.ts`
 * (BSL-1.1) with permission; see the repository NOTICE.
 */
const FINGERPRINT_RE = /^sha256\/[A-Za-z0-9_-]+$/;

export function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_RE.test(value);
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < buf.length; i++) {
    bin += String.fromCharCode(buf[i] as number);
  }
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function sha256Fingerprint(der: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SubtleCrypto is not available in this environment');
  }
  const view = der instanceof Uint8Array ? der : new Uint8Array(der);
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  const digest = await subtle.digest('SHA-256', buf);
  return `sha256/${base64UrlEncode(digest)}`;
}

/** Length-independent, byte-for-byte comparison of two fingerprints. */
export function fingerprintsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
