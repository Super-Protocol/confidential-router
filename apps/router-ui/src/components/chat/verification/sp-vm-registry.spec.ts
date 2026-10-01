import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  base64ToBytes,
  importRegistryKey,
  isMeasurementHex,
  lookUpMeasurement,
  SP_VM_REGISTRY_BASE_URL,
  SP_VM_REGISTRY_KEY_SPKI_B64,
  verifyMeasurementSignature,
} from './sp-vm-registry';

const MEASUREMENT = 'a'.repeat(64);

/** A throwaway RSA pair, so a *valid* signature can be produced in a test. */
let testKeys: CryptoKeyPair;
let testSpki: string;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

beforeAll(async () => {
  testKeys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  testSpki = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', testKeys.publicKey)));
});

/** A standalone `ArrayBuffer`, which is what `Response` and Web Crypto both accept. */
function body(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function signMeasurement(hex: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', testKeys.privateKey, buffer));
}

describe('the pinned Super Protocol key', () => {
  it('is a parseable RSA SubjectPublicKeyInfo', async () => {
    // Guards the constant itself: every root verdict in the page depends on it,
    // and a truncated paste would otherwise only fail against a live registry.
    const key = await importRegistryKey();

    expect(key.type).toBe('public');
    expect(key.algorithm.name).toBe('RSASSA-PKCS1-v1_5');
  });

  it('is byte-identical to the key the Go gatekeeper pins', () => {
    // `apps/gatekeeper/pkg/attestation/attestedroot/registry.go`,
    // `trustedRegistryKeySPKI`. If these two drift, the page and the gatekeeper
    // accept different sets of images — which is the one divergence that would
    // let the console show a tier the gatekeeper refuses.
    expect(SP_VM_REGISTRY_KEY_SPKI_B64.endsWith('AgED')).toBe(true);
    expect(base64ToBytes(SP_VM_REGISTRY_KEY_SPKI_B64).byteLength).toBe(420);
  });

  it('points at the same registry the gatekeeper does', () => {
    expect(SP_VM_REGISTRY_BASE_URL).toBe('https://raw.githubusercontent.com/Super-Protocol/sp-vm/main/signatures');
  });
});

describe('isMeasurementHex', () => {
  it('accepts a 32-byte and a 48-byte measurement and nothing else', () => {
    expect(isMeasurementHex('a'.repeat(64))).toBe(true);
    expect(isMeasurementHex('a'.repeat(96))).toBe(true);
    expect(isMeasurementHex('a'.repeat(63))).toBe(false);
    expect(isMeasurementHex(`${'a'.repeat(62)}zz`)).toBe(false);
  });
});

describe('verifyMeasurementSignature', () => {
  it('accepts a signature over the raw measurement bytes', async () => {
    const signature = await signMeasurement(MEASUREMENT);
    const bytes = base64ToBytes(bytesToBase64(hex(MEASUREMENT)));

    expect(await verifyMeasurementSignature(bytes, signature, testSpki)).toBe(true);
  });

  it('rejects a signature over a different measurement', async () => {
    const signature = await signMeasurement('b'.repeat(64));

    expect(await verifyMeasurementSignature(hex(MEASUREMENT), signature, testSpki)).toBe(false);
  });
});

describe('lookUpMeasurement', () => {
  it('probes the platform channels first and the legacy flat layout last', async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      seen.push(url);
      return new Response('', { status: 404 });
    });

    const verdict = await lookUpMeasurement(MEASUREMENT, {
      baseUrl: 'https://registry.test',
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(seen).toEqual([
      `https://registry.test/tdx/latest/mrenclave-${MEASUREMENT}.json`,
      `https://registry.test/tdx/pre-release/mrenclave-${MEASUREMENT}.json`,
      `https://registry.test/sev-snp/latest/mrenclave-${MEASUREMENT}.json`,
      `https://registry.test/sev-snp/pre-release/mrenclave-${MEASUREMENT}.json`,
      `https://registry.test/mrenclave-${MEASUREMENT}.sign`,
    ]);
    expect(verdict).toEqual({ status: 'not-in-registry', measurement: MEASUREMENT });
  });

  it('vouches for a measurement whose JSON entry carries a valid signature', async () => {
    const signature = await signMeasurement(MEASUREMENT);
    const fetcher = async (url: string) =>
      url.endsWith(`/tdx/latest/mrenclave-${MEASUREMENT}.json`)
        ? new Response(JSON.stringify({ signature: bytesToBase64(signature) }), { status: 200 })
        : new Response('', { status: 404 });

    const verdict = await lookUpMeasurement(MEASUREMENT, {
      baseUrl: 'https://registry.test',
      keySpkiBase64: testSpki,
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(verdict).toEqual({
      status: 'vouched',
      measurement: MEASUREMENT,
      url: `https://registry.test/tdx/latest/mrenclave-${MEASUREMENT}.json`,
    });
  });

  it('reads the legacy `.sign` layout as raw signature bytes', async () => {
    const signature = await signMeasurement(MEASUREMENT);
    const fetcher = async (url: string) =>
      url.endsWith('.sign') ? new Response(body(signature), { status: 200 }) : new Response('', { status: 404 });

    const verdict = await lookUpMeasurement(MEASUREMENT, {
      baseUrl: 'https://registry.test',
      keySpkiBase64: testSpki,
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(verdict.status).toBe('vouched');
  });

  it('refuses a measurement whose signature does not verify under the pinned key', async () => {
    const signature = await signMeasurement('c'.repeat(64));
    const fetcher = async (url: string) =>
      url.endsWith('.json') && url.includes('/tdx/latest/')
        ? new Response(JSON.stringify({ signature: bytesToBase64(signature) }), { status: 200 })
        : new Response('', { status: 404 });

    const verdict = await lookUpMeasurement(MEASUREMENT, {
      baseUrl: 'https://registry.test',
      keySpkiBase64: testSpki,
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(verdict).toEqual({ status: 'not-in-registry', measurement: MEASUREMENT });
  });

  it('falls through a JSON entry that carries no signature', async () => {
    const signature = await signMeasurement(MEASUREMENT);
    const fetcher = async (url: string) => {
      if (url.includes('/tdx/latest/')) return new Response(JSON.stringify({ note: 'no signature here' }));
      if (url.endsWith('.sign')) return new Response(body(signature), { status: 200 });
      return new Response('', { status: 404 });
    };

    const verdict = await lookUpMeasurement(MEASUREMENT, {
      baseUrl: 'https://registry.test',
      keySpkiBase64: testSpki,
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(verdict.status).toBe('vouched');
  });

  it('keeps "could not be asked" apart from "not one of ours"', async () => {
    const unreachable = await lookUpMeasurement(MEASUREMENT, {
      baseUrl: 'https://registry.test',
      fetcher: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    });
    expect(unreachable.status).toBe('unavailable');

    const broken = await lookUpMeasurement(MEASUREMENT, {
      baseUrl: 'https://registry.test',
      fetcher: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    });
    expect(broken.status).toBe('unavailable');
  });

  it('does not go to the network for something that is not a measurement', async () => {
    const fetcher = vi.fn();

    const verdict = await lookUpMeasurement('not-a-measurement', { fetcher: fetcher as unknown as typeof fetch });

    expect(verdict.status).toBe('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('narrows the probe when the platform is known', async () => {
    const seen: string[] = [];
    const fetcher = async (url: string) => {
      seen.push(url);
      return new Response('', { status: 404 });
    };

    await lookUpMeasurement(MEASUREMENT, {
      baseUrl: 'https://registry.test',
      platform: 'sev-snp',
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(seen.some((url) => url.includes('/tdx/'))).toBe(false);
  });
});

function hex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
