import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Extension, X509Certificate, X509CertificateGenerator } from '@peculiar/x509';
import { beforeAll, describe, expect, it } from 'vitest';
import { OID_CHALLENGE_TYPE, OID_NETWORK_TYPE, OID_TEE_EVIDENCE, readRootAttestation } from '../root-tee-evidence.js';

/**
 * The reader is held to a real `Super Swarm Root CA`, not to a certificate we
 * encoded ourselves: the bug it exists to close (SUP-185) was a surface claiming
 * the platform published no TEE quote for a hostname whose root carried a full
 * SEV-SNP report, and only a fixture the platform actually emitted can prove the
 * claim is now made against what is there.
 *
 * Provenance and the reason it is pinned rather than fetched: `testdata/README.md`.
 */
const TESTDATA = join(fileURLToPath(new URL('./testdata', import.meta.url)));

const LIVE_ROOT_PEM = readFileSync(join(TESTDATA, 'swarm-root-sev-snp.pem'), 'utf8');

/**
 * The report's own 48-byte `MEASUREMENT` for this fixture.
 *
 * Worth stating in full, because the gap between this value and the registry's is
 * the whole reason the reader does not do a lookup: the sp-vm registry indexes
 * this VM under `bb6962eb20d616eb0f19479cf7fbccda50ee5682eab75b2104915d305a826aab`,
 * the wrapped *normalised* launch digest, which is reachable only by rebuilding
 * the digest from the release's OVMF image. Handing the value below to a registry
 * lookup would answer "not in the registry" for a sound VM.
 */
const REPORT_MEASUREMENT =
  'ad175671b4c2f3929ecb8e6b0b37765cf90a82071e8b53f2df8730e0d68af60ba4513b26503bc63cd5d82e997363c424';

/** The evidence blob of the live root, for re-attaching to other certificates. */
let liveEvidence: Uint8Array;

beforeAll(() => {
  const extension = new X509Certificate(LIVE_ROOT_PEM).getExtension(OID_TEE_EVIDENCE);
  if (!extension) throw new Error('the fixture root carries no TEE evidence extension');
  liveEvidence = new Uint8Array(extension.value);
});

/** A self-signed certificate carrying whatever extensions a case needs. */
async function rootCarrying(extensions: Extension[]): Promise<X509Certificate> {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  );
  return X509CertificateGenerator.createSelfSigned({
    name: 'CN=Test Root',
    serialNumber: '01',
    notBefore: new Date('2026-01-01T00:00:00.000Z'),
    notAfter: new Date('2036-01-01T00:00:00.000Z'),
    signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    keys,
    extensions,
  });
}

function text(oid: string, value: string): Extension {
  return new Extension(oid, false, new TextEncoder().encode(value).buffer as ArrayBuffer);
}

function bytes(oid: string, value: Uint8Array): Extension {
  return new Extension(oid, false, value.slice().buffer as ArrayBuffer);
}

describe('a real Super Swarm root', () => {
  it('reads all three attestation extensions off the certificate the platform serves', async () => {
    const attestation = await readRootAttestation(new X509Certificate(LIVE_ROOT_PEM));

    expect(attestation.challengeType).toBe('sev-snp');
    expect(attestation.networkType).toBe('untrusted');
    expect(attestation.carriesEvidence).toBe(true);
    expect(attestation.error).toBeNull();
  });

  it('decodes the SEV-SNP branch, its release and its report measurement', async () => {
    const { evidence } = await readRootAttestation(new X509Certificate(LIVE_ROOT_PEM));

    expect(evidence).not.toBeNull();
    expect(evidence?.type).toBe('sev-snp-qemu');
    expect(evidence?.label).toBe('AMD SEV-SNP (QEMU)');
    expect(evidence?.registryFolder).toBe('sev-snp');
    expect(evidence?.build).toBe('build-370');
    expect(evidence?.reportMeasurement).toBe(REPORT_MEASUREMENT);
  });

  it('reads the policy and TCB fields the gatekeeper reports for this same root', async () => {
    /*
     * The three values pinned here are the three the Go verifier's own fixture
     * test asserts for the live root — `SecurityFields{VMPL: 0, SnpFirmwareTCB:
     * 27, ReportVersion: 5}` in `attestedroot/verifier_test.go`. Holding both
     * readers to the same numbers is the point: a console showing a TCB level
     * the gatekeeper disagrees with would be worse than a console showing none.
     */
    const { evidence } = await readRootAttestation(new X509Certificate(LIVE_ROOT_PEM));
    const security = evidence?.security;

    expect(security).not.toBeNull();
    expect(security?.reportVersion).toBe(5);
    expect(security?.vmpl).toBe(0);
    expect(security?.launchTcb.snp).toBe(27);

    // The rest of the launch TCB, so a platform held back on one component shows
    // up here rather than silently behind the single SNP number.
    expect(security?.launchTcb).toEqual({
      raw: '0x581b00000000000a',
      bootLoader: 10,
      tee: 0,
      snp: 27,
      microcode: 88,
    });
    // This VM launched on the TCB it still runs, and asks to be held to it.
    expect(security?.currentTcb.raw).toBe(security?.launchTcb.raw);
    expect(security?.reportedTcb.raw).toBe(security?.launchTcb.raw);
  });

  it('decomposes the guest policy, and says debug is not permitted', async () => {
    // `debugAllowed` is the one bit whose bad value nobody tolerates: it means
    // the host may decrypt the guest. The live root's policy is 0x30000 — SMT
    // allowed, the ABI's reserved bit 17 set, and nothing else.
    const { evidence } = await readRootAttestation(new X509Certificate(LIVE_ROOT_PEM));

    expect(evidence?.security?.policy).toEqual({
      raw: '0x30000',
      abiMajor: 0,
      abiMinor: 0,
      smtAllowed: true,
      migrateMaAllowed: false,
      debugAllowed: false,
      singleSocketRequired: false,
      ciphertextHiding: false,
      pageSwapDisabled: false,
    });
  });

  it('confirms the report commits to this certificate’s own public key', async () => {
    /*
     * The one cryptographic statement a browser can get out of the extension
     * cheaply, and the one that makes the report be *about* this CA: the VM asked
     * the firmware to bind SHA-256(SubjectPublicKeyInfo) into REPORT_DATA when it
     * enrolled. Without it, a sound report from any Super Protocol VM would vouch
     * for any certificate.
     */
    const { evidence } = await readRootAttestation(new X509Certificate(LIVE_ROOT_PEM));

    expect(evidence?.keyBinding).toBe(true);
  });

  it('says false — not null — when the same evidence is attached to a different key', async () => {
    // The forgery the binding check exists to catch: real, verifiable hardware
    // evidence, lifted onto a certificate whose key it says nothing about.
    const impostor = await rootCarrying([
      text(OID_CHALLENGE_TYPE, 'sev-snp'),
      text(OID_NETWORK_TYPE, 'untrusted'),
      bytes(OID_TEE_EVIDENCE, liveEvidence),
    ]);

    const { evidence } = await readRootAttestation(impostor);

    expect(evidence?.keyBinding).toBe(false);
    expect(evidence?.build).toBe('build-370');
  });
});

describe('a real Azure SEV-SNP root (SUP-251)', () => {
  const AZURE_ROOT_PEM = readFileSync(join(TESTDATA, 'apps-448-azure-sev-snp-root.pem'), 'utf8');

  it('recognises the Azure branch instead of calling the evidence unreadable', async () => {
    const attestation = await readRootAttestation(new X509Certificate(AZURE_ROOT_PEM));

    expect(attestation.error).toBeNull();
    expect(attestation.challengeType).toBe('sev-snp-azure');
    expect(attestation.networkType).toBe('trusted');
    expect(attestation.evidence).toMatchObject({
      type: 'sev-snp-azure',
      label: 'AMD SEV-SNP (Azure)',
      registryFolder: 'sev-snp',
      build: null,
    });
    expect(attestation.evidence?.security?.policy.debugAllowed).toBe(false);
  });

  it('follows the key binding through the HCL runtime data to this certificate', async () => {
    // Two links, both checked: the SEV-SNP report commits to the paravisor's
    // runtime data, and that data's user-data commits to the CA key.
    const { evidence } = await readRootAttestation(new X509Certificate(AZURE_ROOT_PEM));

    expect(evidence?.keyBinding).toBe(true);
  });

  it('says false when the same Azure evidence is attached to a different key', async () => {
    const extension = new X509Certificate(AZURE_ROOT_PEM).getExtension(OID_TEE_EVIDENCE);
    if (!extension) throw new Error('the Azure fixture carries no TEE evidence extension');
    const impostor = await rootCarrying([
      text(OID_CHALLENGE_TYPE, 'sev-snp-azure'),
      bytes(OID_TEE_EVIDENCE, new Uint8Array(extension.value)),
    ]);

    const { evidence } = await readRootAttestation(impostor);

    expect(evidence?.type).toBe('sev-snp-azure');
    expect(evidence?.keyBinding).toBe(false);
  });
});

describe('a root with no attestation extensions', () => {
  it('is not an error: an ordinary CA simply says nothing', async () => {
    const plain = await rootCarrying([]);

    const attestation = await readRootAttestation(plain);

    expect(attestation).toEqual({
      challengeType: null,
      networkType: null,
      carriesEvidence: false,
      evidence: null,
      error: null,
    });
  });
});

describe('extensions that are present but unusable', () => {
  it('keeps "carries evidence I cannot read" apart from "carries no evidence"', async () => {
    /*
     * The distinction the whole bug turned on. A surface that collapsed these two
     * would state the platform published nothing for a hostname that published
     * something — which is what SUP-185 reported.
     */
    const broken = await rootCarrying([bytes(OID_TEE_EVIDENCE, new Uint8Array([0x0a, 0x7f]))]);

    const attestation = await readRootAttestation(broken);

    expect(attestation.carriesEvidence).toBe(true);
    expect(attestation.evidence).toBeNull();
    expect(attestation.error).toMatch(/past the end of the message/);
  });

  it('refuses an empty evidence extension rather than reporting an absent one', async () => {
    const empty = await rootCarrying([bytes(OID_TEE_EVIDENCE, new Uint8Array())]);

    const attestation = await readRootAttestation(empty);

    expect(attestation.carriesEvidence).toBe(true);
    expect(attestation.error).toMatch(/empty TEE evidence extension/);
  });

  it('refuses evidence carrying two hardware branches instead of picking one', async () => {
    // Which branch is present selects both the verifier and the registry folder,
    // so a message with two has no single answer to either question. The
    // gatekeeper's ParseEvidence refuses it for the same reason; the two readers
    // must agree on what a message means.
    const both = new Uint8Array([...liveEvidence, 0x12, 0x00]);
    const ambiguous = await rootCarrying([bytes(OID_TEE_EVIDENCE, both)]);

    const attestation = await readRootAttestation(ambiguous);

    expect(attestation.error).toMatch(/more than one hardware branch/);
    expect(attestation.evidence).toBeNull();
  });

  it('reports an undefined network type without losing the evidence beside it', async () => {
    const odd = await rootCarrying([text(OID_NETWORK_TYPE, 'semi-trusted'), bytes(OID_TEE_EVIDENCE, liveEvidence)]);

    const attestation = await readRootAttestation(odd);

    expect(attestation.networkType).toBeNull();
    expect(attestation.error).toMatch(/"semi-trusted"/);
    expect(attestation.evidence?.type).toBe('sev-snp-qemu');
  });
});

describe('how the platform spells an extension value', () => {
  it('accepts a DER-wrapped string as well as the bare ASCII the live root uses', async () => {
    /*
     * Generators disagree about whether to wrap these values in an OCTET STRING
     * or a UTF8String. The live root writes them bare; rejecting either spelling
     * would refuse a root the platform's own verifier accepts, so the gatekeeper
     * tolerates all three and this reader has to match it.
     */
    const wrapped = await rootCarrying([
      bytes(OID_CHALLENGE_TYPE, new Uint8Array([0x0c, 0x07, ...new TextEncoder().encode('sev-snp')])),
      bytes(OID_NETWORK_TYPE, new Uint8Array([0x04, 0x07, ...new TextEncoder().encode('trusted')])),
    ]);

    const attestation = await readRootAttestation(wrapped);

    expect(attestation.challengeType).toBe('sev-snp');
    expect(attestation.networkType).toBe('trusted');
  });
});
