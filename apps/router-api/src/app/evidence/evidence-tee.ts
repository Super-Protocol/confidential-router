import { X509Certificate } from 'node:crypto';

/**
 * Names the TEE a published bundle's evidence comes from, read off the root
 * certificate of its chain.
 *
 * Before this, every console surface printed the operator-declared `tee` label
 * from the router config next to the evidence, and the chart's default ("Intel
 * TDX + H100 CC") ended up on a production deployment whose root carries an
 * AMD SEV-SNP (Azure) report (SUP-270). The label a user reads next to a digest
 * has to come from the evidence itself.
 *
 * A Super Swarm root carries its enrolment `TeeEvidence` in the extension
 * {@link OID_TEE_EVIDENCE}; which top-level field of that message is set — the
 * hardware *branch* — is the TEE. That is all this reads: the field number. Not
 * the report inside it, not the chain, not the signature. Like
 * `evidence-bundle.ts` it is a reader and must never become a verifier
 * (ADR-002), and for the same reason it does not import
 * `@confidential-router/attestation`, whose `readRootAttestation` decodes the
 * same extension in full for the browser. The branch numbers and labels below
 * mirror that reader's and the gatekeeper's `attestedroot.EvidenceType`; the
 * three must agree on what a branch means.
 */

/** Carries the serialised TeeEvidence the CA enrolled with. */
export const OID_TEE_EVIDENCE = '0.6.9.42.840.113741.1337.6';

/** The TeeEvidence branch field → how the platform's own surfaces name it. */
const BRANCH_LABELS: Record<number, string> = {
  1: 'AMD SEV-SNP (QEMU)',
  2: 'Intel TDX (QEMU)',
  3: 'Intel TDX (GCP)',
  4: 'Intel TDX (Azure)',
  5: 'AMD SEV-SNP (Azure)',
};

/**
 * The TEE label of a stored bundle, or null when it names none this reader
 * recognises.
 *
 * Never throws: the label is display detail, and a bundle the router has
 * already accepted must not become unrenderable because its root is an
 * ordinary CA, carries no evidence, or carries evidence from a newer producer.
 * Null is "the evidence does not say", which the console renders as such —
 * never as the operator's declared label.
 */
export function teeLabelOfBundle(bundle: Record<string, unknown>): string | null {
  const chain = bundle.certChain;
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const rootPem = chain[chain.length - 1];
  if (typeof rootPem !== 'string') return null;
  try {
    const evidence = extensionValue(new Uint8Array(new X509Certificate(rootPem).raw), OID_TEE_EVIDENCE);
    return evidence ? teeLabelOfEvidence(evidence) : null;
  } catch {
    return null;
  }
}

/**
 * The label of a serialised TeeEvidence's hardware branch.
 *
 * Exactly one branch must be set: the branches are alternatives, and a message
 * carrying two has no single answer — the gatekeeper's `ParseEvidence` and the
 * browser reader refuse it, so this does not pick one either.
 */
export function teeLabelOfEvidence(message: Uint8Array): string | null {
  let label: string | null = null;
  for (const field of protobufFields(message)) {
    const branch = field.lengthDelimited ? BRANCH_LABELS[field.number] : undefined;
    if (!branch) continue;
    if (label !== null) return null;
    label = branch;
  }
  return label;
}

/** Top-level fields of a protobuf message; throws on a truncated one. */
function* protobufFields(message: Uint8Array): Generator<{ number: number; lengthDelimited: boolean }> {
  let offset = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      if (offset >= message.length || shift > 49) throw new Error('truncated varint');
      const byte = message[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
  };
  while (offset < message.length) {
    const key = varint();
    const wire = key % 8;
    const number = Math.floor(key / 8);
    if (wire === 0) varint();
    else if (wire === 1) offset += 8;
    else if (wire === 2) {
      // Read first: `offset += varint()` would add to the offset from before
      // the length prefix was consumed.
      const length = varint();
      offset += length;
    } else if (wire === 5) offset += 4;
    else throw new Error(`unsupported wire type ${wire}`);
    if (offset > message.length) throw new Error('field runs past the end of the message');
    yield { number, lengthDelimited: wire === 2 };
  }
}

/**
 * The `extnValue` of one extension of a DER certificate, or null when absent.
 *
 * Node's `X509Certificate` does not expose arbitrary extensions, so the DER is
 * walked: every constructed value is descended into, and an `Extension` is the
 * SEQUENCE whose first element is the wanted OID and whose last is the OCTET
 * STRING holding the value. Primitive values — extension payloads included —
 * are never descended into, so nothing inside a payload can be mistaken for an
 * extension.
 */
function extensionValue(der: Uint8Array, oid: string): Uint8Array | null {
  const wanted = encodeOid(oid);
  const search = (start: number, end: number): Uint8Array | null => {
    for (let offset = start; offset < end; ) {
      const tlv = readTlv(der, offset);
      if (tlv.constructed) {
        if (tlv.tag === 0x30) {
          const children = childrenOf(der, tlv.contentStart, tlv.end);
          const [first] = children;
          const last = children[children.length - 1];
          if (
            first &&
            last &&
            children.length >= 2 &&
            first.tag === 0x06 &&
            last.tag === 0x04 &&
            bytesEqual(der.subarray(first.contentStart, first.end), wanted)
          ) {
            return der.subarray(last.contentStart, last.end);
          }
        }
        const found = search(tlv.contentStart, tlv.end);
        if (found) return found;
      }
      offset = tlv.end;
    }
    return null;
  };
  return search(0, der.length);
}

interface Tlv {
  tag: number;
  constructed: boolean;
  contentStart: number;
  end: number;
}

function childrenOf(der: Uint8Array, start: number, end: number): Tlv[] {
  const children: Tlv[] = [];
  for (let offset = start; offset < end; ) {
    const tlv = readTlv(der, offset);
    children.push(tlv);
    offset = tlv.end;
  }
  return children;
}

function readTlv(der: Uint8Array, offset: number): Tlv {
  const tag = der[offset];
  let lengthByte = der[offset + 1];
  if (tag === undefined || lengthByte === undefined) throw new Error('truncated DER');
  let contentStart = offset + 2;
  let length = lengthByte;
  if (lengthByte & 0x80) {
    const octets = lengthByte & 0x7f;
    if (octets === 0 || octets > 4) throw new Error('unsupported DER length');
    length = 0;
    for (let index = 0; index < octets; index++) {
      lengthByte = der[contentStart++];
      if (lengthByte === undefined) throw new Error('truncated DER');
      length = length * 256 + lengthByte;
    }
  }
  const end = contentStart + length;
  if (end > der.length) throw new Error('DER value runs past the end of the certificate');
  return { tag, constructed: (tag & 0x20) !== 0, contentStart, end };
}

/** DER content octets of a dotted OID. */
function encodeOid(oid: string): Uint8Array {
  const [first = 0, second = 0, ...rest] = oid.split('.').map(Number);
  const out: number[] = [];
  for (const arc of [first * 40 + second, ...rest]) {
    const septets = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) {
      septets.unshift((value & 0x7f) | 0x80);
    }
    out.push(...septets);
  }
  return new Uint8Array(out);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
