/**
 * What a Super Swarm root certificate says about the VM that enrolled it.
 *
 * A root issued by the platform carries three non-standard extensions — the
 * constants of `@super-protocol/pki-common`, and the same three
 * `apps/gatekeeper/pkg/attestation/attestedroot/certificate.go` reads:
 *
 * ```
 * 1.3.6.1.3.8888.1.1            challenge type  -> "sev-snp" | "tdx" | "tdx-google" | "untrusted"
 * 1.3.6.1.3.8888.4              network type    -> "trusted" | "untrusted"
 * 0.6.9.42.840.113741.1337.6    TEE evidence    -> the serialised TeeEvidence
 * ```
 *
 * Before this module existed nothing on the TypeScript side could see them, and
 * a browser surface holding a bundle whose root carried a full SEV-SNP report
 * had no way to say so — it could only report the *absence* of
 * `rootCaTeeQuote`, which is a different and much weaker statement (SUP-185).
 *
 * ## What this reader is, and what it is not
 *
 * It is a **reader**: it decodes the extensions, and it performs the one
 * cryptographic check a browser can perform on them cheaply — whether the
 * report's `REPORT_DATA` commits to this certificate's public key.
 *
 * It is not a verifier. Two things it deliberately does not do, because both
 * belong to Gatekeeper:
 *
 *  - **The AMD chain.** Whether the report is genuine needs the ARK/ASK/VCEK
 *    chain checked against AMD's built-in roots, plus revocation. The evidence
 *    carries the certificates; nothing here validates them.
 *  - **The registry measurement.** The signed sp-vm registry is *not* indexed by
 *    the report's own `MEASUREMENT`. It is indexed by
 *    `SHA-256(normalised-launch-digest ‖ vmpl ‖ policy)`, where the launch digest
 *    is rebuilt page by page from the release's OVMF image and kernel artefacts
 *    for a canonical single-Milan-core VM — `snpmeasure.Normalize` in the
 *    gatekeeper. Megabytes of firmware and an OVMF metadata parse are not
 *    browser work.
 *
 * That second point is a trap worth naming, because it looks like a shortcut and
 * is not one: passing {@link RootTeeEvidence.reportMeasurement} to a registry
 * lookup would miss every healthy VM and return "not in the registry" for it —
 * a *false accusation*, which is worse than the honest "not established" a
 * surface can report instead. `reportMeasurement` is exposed because it is the
 * datum the normalisation starts from and a reader that dropped it would be
 * hiding the report's headline field; it is not a lookup key.
 */
import type { X509Certificate } from '@peculiar/x509';

/** Names the enrolment challenge the CA answered. */
export const OID_CHALLENGE_TYPE = '1.3.6.1.3.8888.1.1';

/** Which Super Protocol network the CA belongs to. */
export const OID_NETWORK_TYPE = '1.3.6.1.3.8888.4';

/** Carries the serialised TeeEvidence the CA enrolled with. */
export const OID_TEE_EVIDENCE = '0.6.9.42.840.113741.1337.6';

/**
 * The hardware branch of a TeeEvidence. The names are the `TeeEvidenceType`
 * enum of the platform's `TeeEvidence.proto`, and they also select a folder of
 * the signed-measurement registry.
 */
export type RootEvidenceType = 'sev-snp-qemu' | 'tdx-qemu' | 'tdx-gcp';

/** Which Super Protocol network a root declares. */
export type RootNetworkType = 'trusted' | 'untrusted';

/** The registry sub-folder a type's measurements live in; TDX shares one. */
export type RegistryFolder = 'sev-snp' | 'tdx';

export interface RootTeeEvidence {
  type: RootEvidenceType;
  /** The type as the platform's own surfaces label it, e.g. "AMD SEV-SNP (QEMU)". */
  label: string;
  registryFolder: RegistryFolder;
  /** The sp-vm release the VM booted, e.g. `build-370`. SEV-SNP only. */
  build: string | null;
  /**
   * Lowercase hex of the report's own 48-byte `MEASUREMENT`. **Not** a registry
   * lookup key — see this module's header. SEV-SNP only.
   */
  reportMeasurement: string | null;
  /**
   * Whether the report's `REPORT_DATA` commits to this certificate's public key:
   * `REPORT_DATA[0..32) === SHA-256(SubjectPublicKeyInfo)`.
   *
   * `null` when it could not be decided — today that means TDX, whose quote body
   * this repository has no fixture to parse against, so the offsets are not
   * guessed. A `false` is a real negative: the evidence in this certificate
   * attests a *different* key, and Gatekeeper treats that as fatal.
   */
  keyBinding: boolean | null;
}

export interface RootAttestation {
  /** Verbatim value of {@link OID_CHALLENGE_TYPE}, or null when absent. */
  challengeType: string | null;
  /**
   * Value of {@link OID_NETWORK_TYPE}. `null` when the extension is absent —
   * roots predate it — and also when it holds a value the platform does not
   * define, which is recorded in {@link RootAttestation.error}.
   */
  networkType: RootNetworkType | null;
  /** True when {@link OID_TEE_EVIDENCE} is present, whatever it decoded to. */
  carriesEvidence: boolean;
  /** The decoded evidence, or null when absent or undecodable. */
  evidence: RootTeeEvidence | null;
  /**
   * Why an extension that *is* present could not be used. Kept separate from
   * `evidence: null` on purpose: "this root carries no evidence" and "this root
   * carries evidence I could not read" are different sentences, and a surface
   * that conflated them would state the platform published nothing when it did.
   */
  error: string | null;
}

/** A root with none of the extensions: an ordinary CA, which is not an error. */
const NO_ATTESTATION: RootAttestation = {
  challengeType: null,
  networkType: null,
  carriesEvidence: false,
  evidence: null,
  error: null,
};

/**
 * Reads the attestation extensions off a root certificate.
 *
 * Never throws: every certificate is *some* answer, and a surface deciding what
 * to tell a reader needs that answer rather than an exception. A certificate
 * with none of the extensions comes back as {@link NO_ATTESTATION}.
 */
export async function readRootAttestation(root: X509Certificate): Promise<RootAttestation> {
  const challenge = extensionBytes(root, OID_CHALLENGE_TYPE);
  const network = extensionBytes(root, OID_NETWORK_TYPE);
  const evidenceBytes = extensionBytes(root, OID_TEE_EVIDENCE);

  if (!challenge && !network && !evidenceBytes) {
    return NO_ATTESTATION;
  }

  const out: RootAttestation = {
    challengeType: challenge ? extensionText(challenge) || null : null,
    networkType: null,
    carriesEvidence: evidenceBytes !== null,
    evidence: null,
    error: null,
  };

  if (network) {
    const text = extensionText(network);
    if (text === 'trusted' || text === 'untrusted') {
      out.networkType = text;
    } else {
      // Reported rather than thrown, and rather than silently defaulted: a
      // network type nobody defined is a thing a viewer should be told about,
      // and it must not make the evidence beside it unreadable.
      out.error = `the root's network type extension ${OID_NETWORK_TYPE} is "${text}", not "trusted" or "untrusted"`;
    }
  }

  if (evidenceBytes) {
    try {
      out.evidence = await decodeEvidence(evidenceBytes, await spkiDigest(root));
    } catch (error) {
      out.error = (error as Error).message;
    }
  }

  return out;
}

/**
 * SHA-256 of the certificate's SubjectPublicKeyInfo — what the firmware is asked
 * to bind into `REPORT_DATA` at enrolment, and therefore what ties a report to
 * *this* CA key rather than to a Super Protocol VM in general.
 */
async function spkiDigest(root: X509Certificate): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', root.publicKey.rawData));
}

function extensionBytes(root: X509Certificate, oid: string): Uint8Array | null {
  const extension = root.getExtension(oid);
  return extension ? new Uint8Array(extension.value) : null;
}

/**
 * Reads an extension the platform writes as bare ASCII rather than as a DER
 * string.
 *
 * Generators disagree about whether to wrap such a value in an OCTET STRING or a
 * UTF8String, so a single-element wrapper is unwrapped and the bare bytes are
 * used otherwise — the same tolerance as the gatekeeper's `extensionText`, for
 * the same reason: refusing one spelling would reject roots the platform's own
 * verifier accepts. The live root writes them bare.
 */
function extensionText(value: Uint8Array): string {
  const unwrapped = unwrapDERString(value);
  return (unwrapped ?? new TextDecoder().decode(value)).trim();
}

/** DER tags of the two string wrappers seen in the wild. */
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8_STRING = 0x0c;

function unwrapDERString(value: Uint8Array): string | null {
  if (value.length < 2) return null;
  const tag = value[0] as number;
  if (tag !== TAG_OCTET_STRING && tag !== TAG_UTF8_STRING) return null;
  const length = value[1] as number;
  // Only the short form, and only when the wrapper accounts for the whole
  // value: a long-form length here would mean a 128-byte-plus challenge type,
  // which no spelling of these extensions produces.
  if (length > 0x7f || length + 2 !== value.length) return null;
  return new TextDecoder().decode(value.subarray(2));
}

/**
 * Offsets into a SEV-SNP attestation report (AMD SEV-SNP ABI, table 22). The
 * report is a fixed 0x4a0-byte structure, so the two fields this reader needs
 * are reads at constants rather than a parse.
 */
const SNP_REPORT_BYTES = 0x4a0;
const SNP_REPORT_DATA_OFFSET = 0x50;
const SNP_REPORT_DATA_BYTES = 64;
const SNP_MEASUREMENT_OFFSET = 0x90;
const SNP_MEASUREMENT_BYTES = 48;

/** SHA-256, the digest `REPORT_DATA` commits the public key with. */
const SPKI_DIGEST_BYTES = 32;

const LABELS: Record<RootEvidenceType, string> = {
  'sev-snp-qemu': 'AMD SEV-SNP (QEMU)',
  'tdx-qemu': 'Intel TDX (QEMU)',
  'tdx-gcp': 'Intel TDX (GCP)',
};

const FOLDERS: Record<RootEvidenceType, RegistryFolder> = {
  'sev-snp-qemu': 'sev-snp',
  'tdx-qemu': 'tdx',
  'tdx-gcp': 'tdx',
};

/**
 * Decodes a serialised TeeEvidence.
 *
 * The wire format is protobuf, walked by hand rather than through generated
 * code: this is the only protobuf in the package, the message is three small
 * types deep, and a hand-written reader keeps the schema visible beside the code
 * that depends on it. Unknown fields are skipped, so a message from a newer
 * producer still decodes — which is what the format is for. Field numbers and
 * the multiple-branch rejection mirror the gatekeeper's `ParseEvidence`; the two
 * must agree on what a message means.
 */
async function decodeEvidence(serialized: Uint8Array, spki: Uint8Array): Promise<RootTeeEvidence> {
  if (serialized.length === 0) {
    throw new Error('the root certificate carries an empty TEE evidence extension');
  }

  let type: RootEvidenceType | null = null;
  let branch: Uint8Array | null = null;
  for (const field of fields(serialized)) {
    if (field.wire !== 'bytes') continue;
    if (field.number !== 1 && field.number !== 2 && field.number !== 3) continue;
    // The branches are alternatives, and which one is present selects both the
    // verifier and the registry folder. A message carrying two has no single
    // answer to either question, so it is refused rather than resolved by field
    // order.
    if (type !== null) {
      throw new Error('the root certificate’s TEE evidence carries more than one hardware branch');
    }
    type = field.number === 1 ? 'sev-snp-qemu' : field.number === 2 ? 'tdx-qemu' : 'tdx-gcp';
    branch = field.bytes;
  }
  if (type === null || branch === null) {
    throw new Error('the root certificate’s TEE evidence carries no hardware branch this reader recognises');
  }

  const base = { type, label: LABELS[type], registryFolder: FOLDERS[type] };
  if (type !== 'sev-snp-qemu') {
    /*
     * The TDX quote body does carry a reportData, at a fixed offset of a
     * structure that differs between quote versions. There is no TDX root in
     * this repository to prove an offset against, and a key-binding check that
     * reads the wrong 32 bytes would answer `false` for a sound root — the one
     * failure mode this whole feature exists to avoid. So it is left undecided
     * until there is a fixture, and Gatekeeper remains the answer for TDX.
     */
    return { ...base, build: null, reportMeasurement: null, keyBinding: null };
  }

  const report = snpReport(branch);
  return {
    ...base,
    build: report.build,
    reportMeasurement: toHex(
      report.raw.subarray(SNP_MEASUREMENT_OFFSET, SNP_MEASUREMENT_OFFSET + SNP_MEASUREMENT_BYTES),
    ),
    keyBinding: bindsPublicKey(
      report.raw.subarray(SNP_REPORT_DATA_OFFSET, SNP_REPORT_DATA_OFFSET + SNP_REPORT_DATA_BYTES),
      spki,
    ),
  };
}

/** The `amdSevSnpQemu` branch: the report and the release that produced it. */
function snpReport(branch: Uint8Array): { raw: Uint8Array; build: string | null } {
  let raw: Uint8Array | null = null;
  let build: string | null = null;

  for (const outer of fields(branch)) {
    // Field 1 is `snpReport`; field 2 repeats the AMD certificates, which this
    // reader does not use — validating them is Gatekeeper's job.
    if (outer.number !== 1 || outer.wire !== 'bytes') continue;
    for (const inner of fields(outer.bytes)) {
      if (inner.number === 1 && inner.wire === 'bytes') raw = inner.bytes;
      if (inner.number === 5 && inner.wire === 'bytes') build = new TextDecoder().decode(inner.bytes).trim() || null;
    }
  }

  if (!raw) {
    throw new Error('the root certificate’s SEV-SNP evidence carries no attestation report');
  }
  if (raw.length < SNP_REPORT_BYTES) {
    throw new Error(
      `the root certificate’s SEV-SNP attestation report is ${raw.length} bytes, expected at least ${SNP_REPORT_BYTES}`,
    );
  }
  return { raw, build };
}

/**
 * Whether `REPORT_DATA` commits to the certificate's public key.
 *
 * Only the first 32 bytes are compared: the rest of the 64-byte field is zero
 * padding, or an NVIDIA token digest on GPU hosts. Same rule as the
 * gatekeeper's `BindsPublicKey`.
 */
function bindsPublicKey(reportData: Uint8Array, spki: Uint8Array): boolean {
  if (spki.length !== SPKI_DIGEST_BYTES || reportData.length < SPKI_DIGEST_BYTES) return false;
  let diff = 0;
  for (let index = 0; index < SPKI_DIGEST_BYTES; index += 1) {
    diff |= (reportData[index] as number) ^ (spki[index] as number);
  }
  return diff === 0;
}

type ProtoField =
  | { number: number; wire: 'bytes'; bytes: Uint8Array }
  | { number: number; wire: 'varint'; value: bigint }
  | { number: number; wire: 'skipped' };

/**
 * Walks a protobuf message, yielding one entry per field. Length-delimited
 * values are sub-arrays of `message` rather than copies, and the fixed-width
 * wire types are skipped rather than decoded — nothing in TeeEvidence uses them.
 */
function* fields(message: Uint8Array): Generator<ProtoField> {
  let cursor = 0;
  while (cursor < message.length) {
    const tag = varint(message, cursor);
    cursor = tag.next;
    const number = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (number <= 0) throw new Error(`TEE evidence: invalid field number ${number}`);

    switch (wire) {
      case 0: {
        const value = varint(message, cursor);
        cursor = value.next;
        yield { number, wire: 'varint', value: value.value };
        break;
      }
      case 2: {
        const length = varint(message, cursor);
        const end = length.next + Number(length.value);
        if (Number(length.value) < 0 || end > message.length) {
          throw new Error(`TEE evidence: field ${number} claims ${length.value} bytes, past the end of the message`);
        }
        yield { number, wire: 'bytes', bytes: message.subarray(length.next, end) };
        cursor = end;
        break;
      }
      case 1:
      case 5: {
        const width = wire === 1 ? 8 : 4;
        if (cursor + width > message.length) {
          throw new Error(`TEE evidence: field ${number} has a truncated fixed-width value`);
        }
        cursor += width;
        yield { number, wire: 'skipped' };
        break;
      }
      default:
        throw new Error(`TEE evidence: field ${number} has unsupported wire type ${wire}`);
    }
  }
}

/** Ten groups is the most a 64-bit varint may take. */
const MAX_VARINT_BYTES = 10;

function varint(message: Uint8Array, start: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  for (let index = 0; index < MAX_VARINT_BYTES; index += 1) {
    const at = start + index;
    if (at >= message.length) break;
    const byte = message[at] as number;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: at + 1 };
    shift += 7n;
  }
  throw new Error('TEE evidence: malformed varint');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
