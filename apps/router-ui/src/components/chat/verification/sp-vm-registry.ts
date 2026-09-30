/**
 * "Is this measurement one Super Protocol vouches for?", asked from the page.
 *
 * The registry is a set of RSASSA-PKCS1-v1_5 signatures over VM launch
 * measurements, published as files named after the measurement they cover: a hit
 * *is* the statement "this image is one of ours". The signing key is pinned in
 * this module rather than taken from the transport, because the files are served
 * over plain HTTPS from a Git host — with the key pinned, whoever controls that
 * host can only withhold an answer, which fails closed.
 *
 * It is the same key, the same probe order and the same signature scheme as the
 * gatekeeper's `apps/gatekeeper/pkg/attestation/attestedroot/registry.go`, so the
 * page and the Go verifier accept exactly the same set of images. Keep them in
 * step: a divergence here would let the console show a green tier the gatekeeper
 * would refuse.
 */

/** Where Super Protocol publishes the signatures. */
export const SP_VM_REGISTRY_BASE_URL = 'https://raw.githubusercontent.com/Super-Protocol/sp-vm/main/signatures';

/**
 * The RSA-3072 public key, DER SubjectPublicKeyInfo in base64, that signs every
 * entry. Identical to `trustedRegistryKeySPKI` in the Go verifier and to
 * `TRUSTED_PUBLIC_KEY_SPKI_B64` in `@super-protocol/attestation-common`.
 */
export const SP_VM_REGISTRY_KEY_SPKI_B64 =
  'MIIBoDANBgkqhkiG9w0BAQEFAAOCAY0AMIIBiAKCAYEAy99uld749OD5W48roZ4MbuKk1Bo7tGIfEOot1+xlWQKDDBaRQDg+LOGhPpRmGbF/s4t9rUGvxBnjyl+PtpLyJkx+eBT6ubTEb/4SbdgiqPjtXXV0eUVYoBZHSmT9YFklcJ1YWDwYxOm0skh/wm5IBpSnGMuLp2mc8Fyq+vxWzEPeFzbLH6QWdG/9Ts5mJHJ3UaWG1fW4lSMf3eVc9BRwpa7tpXpURLj2TsX8wgCbQVQ1+QYLoCdS6HZc57vsIGR6TxHeqmaJWpDaXBV8dzw9aekTGadk9/IetjI1baX9BJ8s7Ipx9fYnf9qwmWezBO1cmOowm9Md6TMPEkVxvzady+rMyLWbGrJoaJ6HW5EPYoFQW2cBFOd1QzS4ajL3t/SXQpB3TnBSyeIz+8OowH+aAd7/9vCI5Ro8j0RsnDU/T3mNkb5pA4OwY6qxornR39RmHTz3GaRZemK++pfPR33AVMlJdspym+qQVI4TtaqzcI+yOHdGTD2vMTuiRQ7+1i89AgED';

/** The registry's sub-folders. TDX under QEMU and under GCP share one. */
export type SpVmPlatform = 'tdx' | 'sev-snp';

/**
 * What a lookup concluded.
 *
 * `not-in-registry` and `unavailable` are kept apart on purpose: the first means
 * "not one of ours" and is a verdict, the second means "nobody could be asked"
 * and is not. Collapsing them would let a blocked request read as a rejection.
 */
export type RegistryVerdict =
  | { status: 'vouched'; measurement: string; url: string }
  | { status: 'not-in-registry'; measurement: string }
  | { status: 'unavailable'; reason: string };

export interface LookUpOptions {
  baseUrl?: string;
  /** DER SubjectPublicKeyInfo in base64. Overridden only by tests. */
  keySpkiBase64?: string;
  fetcher?: typeof fetch;
  /** Narrows the probe to one platform's folder; both are tried when omitted. */
  platform?: SpVmPlatform;
}

/** A measurement is a lowercase hex string of 32 or 48 bytes. */
const MEASUREMENT_RE = /^[0-9a-f]{64}$|^[0-9a-f]{96}$/;

/** A signature is a few hundred bytes; anything past this is the wrong URL. */
const MAX_BODY_BYTES = 1 << 16;

export function isMeasurementHex(value: string): boolean {
  return MEASUREMENT_RE.test(value);
}

/**
 * Asks the registry about one measurement.
 *
 * Probes the same paths in the same order as the Go verifier: each platform's
 * release channel, then its pre-release channel, then the legacy flat layout. A
 * 404 falls through; any other status means the registry could not be consulted,
 * which is `unavailable` rather than a refusal.
 */
export async function lookUpMeasurement(measurementHex: string, options: LookUpOptions = {}): Promise<RegistryVerdict> {
  const measurement = measurementHex.trim().toLowerCase();
  if (!isMeasurementHex(measurement)) {
    return { status: 'unavailable', reason: 'the evidence publishes no measurement in a form the registry indexes' };
  }

  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== 'function') {
    return { status: 'unavailable', reason: 'no fetch available in this environment' };
  }
  const base = (options.baseUrl ?? SP_VM_REGISTRY_BASE_URL).replace(/\/+$/, '');
  const platforms: SpVmPlatform[] = options.platform ? [options.platform] : ['tdx', 'sev-snp'];

  const paths = [
    ...platforms.flatMap((platform) => [
      `${base}/${platform}/latest/mrenclave-${measurement}.json`,
      `${base}/${platform}/pre-release/mrenclave-${measurement}.json`,
    ]),
    `${base}/mrenclave-${measurement}.sign`,
  ];

  for (const url of paths) {
    let response: Response;
    try {
      response = await fetcher(url, { headers: { accept: '*/*' } });
    } catch (error) {
      return { status: 'unavailable', reason: `${url}: ${(error as Error).message}` };
    }
    if (response.status === 404) continue;
    if (!response.ok) {
      return { status: 'unavailable', reason: `${url}: unexpected status ${response.status}` };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) {
      return { status: 'unavailable', reason: `${url}: response is too large to be a signature` };
    }
    const signature = signatureFrom(url, bytes);
    // A JSON entry with no signature is a miss, exactly as the platform's own
    // client treats it: fall through to the next path.
    if (!signature) continue;

    const ok = await verifyMeasurementSignature(hexToBytes(measurement), signature, options.keySpkiBase64);
    return ok ? { status: 'vouched', measurement, url } : { status: 'not-in-registry', measurement };
  }

  return { status: 'not-in-registry', measurement };
}

/** Reads a signature out of whichever layout the path implies. */
function signatureFrom(url: string, body: Uint8Array): Uint8Array | null {
  if (url.endsWith('.sign')) {
    return body.byteLength > 0 ? body : null;
  }
  let entry: { signature?: unknown };
  try {
    entry = JSON.parse(new TextDecoder().decode(body)) as { signature?: unknown };
  } catch {
    return null;
  }
  if (typeof entry.signature !== 'string' || entry.signature.length === 0) {
    return null;
  }
  try {
    return base64ToBytes(entry.signature);
  } catch {
    return null;
  }
}

/**
 * RSASSA-PKCS1-v1_5 over the raw measurement bytes under the pinned key.
 *
 * Web Crypto hashes the data itself, which is why the measurement is passed
 * whole rather than pre-hashed — the Go side spells the same operation out as
 * `VerifyPKCS1v15(key, SHA256, sha256(mrEnclave), sig)`.
 */
export async function verifyMeasurementSignature(
  measurement: Uint8Array,
  signature: Uint8Array,
  keySpkiBase64: string = SP_VM_REGISTRY_KEY_SPKI_B64,
): Promise<boolean> {
  const key = await importRegistryKey(keySpkiBase64);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, intoBuffer(signature), intoBuffer(measurement));
}

/**
 * Parses the pinned key. Cached per SPKI string: one visit to the screen looks
 * up a measurement per endpoint, and importing an RSA-3072 key is not free.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

export function importRegistryKey(keySpkiBase64: string = SP_VM_REGISTRY_KEY_SPKI_B64): Promise<CryptoKey> {
  const cached = keyCache.get(keySpkiBase64);
  if (cached) return cached;

  const imported = crypto.subtle.importKey(
    'spki',
    intoBuffer(base64ToBytes(keySpkiBase64)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  keyCache.set(keySpkiBase64, imported);
  return imported;
}

/** A standalone `ArrayBuffer`, because a typed array may be a view into a pool. */
function intoBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
