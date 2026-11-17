/**
 * Typed loader for the language-neutral conformance vectors in `../vectors`.
 *
 * The vectors themselves are plain JSON and are the contract: the TypeScript
 * verifier (`@confidential-router/attestation`) and the Go verifier
 * (`libs/swarm-evidence-go/attestation`) must produce the same verdict for every
 * case. This module is only the convenience wrapper the TypeScript side uses;
 * Go reads the same files with `go:embed`.
 *
 * Regenerate with `pnpm nx run attestation-fixtures:generate`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the `vectors/` directory. */
export const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors');

export const EVIDENCE_PATH = '/.well-known/swarm-evidence';

/**
 * Absolute path of the private keys the vectors were generated from.
 *
 * They are test key material and are committed on purpose: a tool that has to
 * *mint* something rooted at a fixture anchor — `tools/mock-evidence-host`
 * stands up a live TLS endpoint with fresh validity windows — needs the issuing
 * keys, not just the certificates the vectors already carry.
 */
export const KEYS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'keys');

/** Names of the key pairs in {@link KEYS_DIR}. */
export type FixtureKeyName =
  | 'rsa-root-a'
  | 'rsa-intermediate-a'
  | 'rsa-leaf-a'
  | 'rsa-root-b'
  | 'rsa-intermediate-b'
  | 'rsa-leaf-b'
  | 'rsa-tls-leaf'
  | 'ec-root'
  | 'ec-intermediate'
  | 'ec-leaf';

/** Reads one PKCS#8 private key of the fixture PKI, PEM-encoded. */
export function loadFixtureKey(name: FixtureKeyName): string {
  return readFileSync(join(KEYS_DIR, `${name}.key.pem`), 'utf8');
}

export type EvidenceKind = 'DeploymentEvidence' | 'ControlPlaneEvidence' | 'KubernetesControlPlaneEvidence';

export type VerifyStage = 'fetch' | 'cert-chain' | 'untrusted-root' | 'jws' | 'tls-fingerprint';

export interface TrustedRootVector {
  name: string;
  /** `sha256/<base64url>` of the root's DER — what a verifier matches on. */
  fingerprint: string;
  pem: string;
}

export interface TrustedRootsFile {
  version: string;
  description: string;
  roots: TrustedRootVector[];
}

export interface CaseRequest {
  hostname: string;
  /** Names into `roots.json`; an empty list means "empty trust store". */
  trustedRoots: string[];
  /** Absent for the producer-asserted binding mode. */
  observedTlsFingerprint?: string;
  /** The instant the case is evaluated at. */
  now: string;
  /** Absent means the freshness stage is skipped. */
  maxBundleAge?: number;
}

/** What the evidence endpoint serves for this case. Exactly one body member is set. */
export interface CaseResponse {
  status: number;
  /** Path relative to `vectors/`, holding the JSON document to serve verbatim. */
  bodyFile?: string;
  /** A literal, non-JSON body. */
  bodyText?: string;
}

/** The claim-set vocabulary a denial is reported in, beside the claims. */
export type ClaimStage = 'options' | 'blob' | 'pki-chain' | 'root-quote' | 'binding' | 'envelope' | 'statement';

/**
 * What the claim core must establish for a case, beside the verdict.
 *
 * The two are different assertions. A verdict is about the bundle pipeline,
 * which both verifiers implement; `claims` is about the `SwarmClaims` document
 * a relying party's policy is written against, and a case can be a sound
 * bundle whose claim set is a denial.
 *
 * In `document`, `quote_appraiser` is the placeholder `<appraiser>` and
 * resolves to whichever appraiser replayed the case; a denial's
 * `denial.reason` is not pinned, only its `stage` and `reasonContains`.
 */
export interface ClaimsExpectation {
  ok: boolean;
  stage?: ClaimStage;
  reasonContains?: string;
  document: Record<string, unknown>;
}

export type CaseVerdict =
  | {
      ok: true;
      kind: EvidenceKind;
      channelBinding: 'observed' | 'producer-asserted';
      /** Name of the trusted root the chain terminated at. */
      matchedRoot: string;
      /** The decoded JWS payload, compared member by member. */
      payload: Record<string, unknown>;
      rootCaTeeQuote?: Record<string, unknown>;
    }
  | {
      ok: false;
      stage: VerifyStage;
      /**
       * A substring every implementation's `reason` must contain. Full reason
       * strings are deliberately not pinned — only the stage and this fragment
       * are normative.
       */
      reasonContains: string;
    };

export type CaseExpectation = CaseVerdict & { claims: ClaimsExpectation };

export interface ConformanceCase {
  id: string;
  description: string;
  request: CaseRequest;
  response: CaseResponse;
  expect: CaseExpectation;
}

export interface ConformanceManifest {
  version: string;
  description: string;
  generator: string;
  /** The instant every case's certificate validity window is centred on. */
  referenceNow: string;
  rootsFile: string;
  cases: ConformanceCase[];
}

export interface EvidenceDigestCase {
  input: string;
  valid: boolean;
  /** Present when `valid` — the canonical `sha256/<base64url>` form. */
  canonical?: string;
  note?: string;
}

export interface EvidenceDigestVectors {
  version: string;
  description: string;
  /** The only base64url characters a 32-byte digest can end with. */
  canonicalFinalCharacters: string;
  cases: EvidenceDigestCase[];
}

function readVector<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(VECTORS_DIR, relativePath), 'utf8')) as T;
}

export function loadConformanceManifest(): ConformanceManifest {
  return readVector<ConformanceManifest>('manifest.json');
}

export function loadTrustedRoots(): TrustedRootVector[] {
  return readVector<TrustedRootsFile>('roots.json').roots;
}

export function loadEvidenceDigestVectors(): EvidenceDigestVectors {
  return readVector<EvidenceDigestVectors>('evidence-digest.json');
}

/** Resolves a case's `request.trustedRoots` names against `roots.json`. */
export function resolveTrustedRoots(names: string[], roots = loadTrustedRoots()): TrustedRootVector[] {
  return names.map((name) => {
    const root = roots.find((r) => r.name === name);
    if (!root) throw new Error(`conformance case references unknown trusted root "${name}"`);
    return root;
  });
}

/** Reads one bundle document by file name, without going through a case. */
export function loadBundle(name: string): Record<string, unknown> {
  return readVector<Record<string, unknown>>(`bundles/${name}.json`);
}

/** The raw document a case's evidence endpoint serves, or `undefined` for a literal body. */
export function loadCaseBody(testCase: ConformanceCase): unknown {
  const { bodyFile } = testCase.response;
  return bodyFile === undefined ? undefined : readVector<unknown>(bodyFile);
}

/**
 * A `fetch` implementation that serves exactly one case at
 * `https://<hostname>/.well-known/swarm-evidence` and throws on any other URL —
 * a verifier that reaches for a different endpoint fails loudly.
 */
export function makeCaseFetcher(testCase: ConformanceCase): typeof fetch {
  const { status, bodyFile, bodyText } = testCase.response;
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== `https://${testCase.request.hostname}${EVIDENCE_PATH}`) {
      throw new Error(`case "${testCase.id}": unexpected fetch URL ${url}`);
    }
    if (bodyFile !== undefined) {
      return new Response(readFileSync(join(VECTORS_DIR, bodyFile), 'utf8'), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(bodyText ?? '', { status, headers: { 'content-type': 'text/plain' } });
  };
}

// ---------------------------------------------------------------------------
// The composite-evidence corpus
// ---------------------------------------------------------------------------

/**
 * The composite corpus (`vectors/composite/`) pins the other form of Super
 * Swarm evidence: a RATS CMW collection carrying the hardware quote, the PKI
 * membership chain, the leader's workload statement and the node's request
 * envelope, appraised into `SwarmClaims`.
 *
 * TypeScript has no composite appraiser today — `@confidential-router/attestation`
 * implements the `/.well-known/swarm-evidence` bundle form — so these loaders
 * exist so that one can be held to the same corpus when it is written, and so
 * that the corpus is checked for self-consistency from this side meanwhile.
 * The Go harness that replays it lives in `libs/swarm-evidence-go/conformance`.
 */
export const COMPOSITE_DIR = 'composite';

export type SwarmPlatform = 'tdx-qemu' | 'tdx-gcp' | 'tdx-azure' | 'snp-qemu' | 'snp-azure';

/** A pinned verification key of an EAT-emitting appraiser. */
export interface EatKey {
  kid: string;
  pem: string;
}

/**
 * Where one Verifier's token carries the values a delegated appraisal needs,
 * and how that Verifier spells them.
 *
 * A claim path is a sequence of JSON member names rather than a dotted
 * string, because claim names contain dots: a Veraison EAR nests its evidence
 * inside a member called `ear.veraison.annotated-evidence`.
 */
export interface ClaimMapping {
  tdattributes: string[];
  mrtd: string[];
  rtmr0: string[];
  rtmr1: string[];
  rtmr2: string[];
  rtmr3: string[];
  seamsvn?: string[];
  tcb_status?: string[];
  binding_data?: string[];
  encoding?: 'hex' | 'base64' | 'base64url';
  binding_data_encoding?: 'hex' | 'base64' | 'base64url';
}

/**
 * One quote appraiser the corpus is replayed through.
 *
 * Everything that distinguishes one Verifier from another is here and nothing
 * is in code: the token format, the issuer, the key and the claim mapping.
 * Two profiles that differ in all of them must appraise the corpus into the
 * same claim sets — which is what "the Verifier is swappable by
 * configuration" means, stated as data. An `eat` profile configures the
 * production delegated appraiser, so what the corpus exercises is the adapter
 * a relying party runs.
 */
export interface AppraiserProfile {
  name: string;
  description: string;
  kind: 'recorded' | 'eat';
  tokenFormat?: 'jwt';
  issuer?: string;
  verificationKey?: EatKey;
  claimMapping?: ClaimMapping;
  /** The attester platforms this appraiser covers. */
  platforms?: SwarmPlatform[];
  /** What it answers for evidence outside that coverage. */
  outsideCoverage?: { stage: ClaimStage; reason: string };
}

export interface CompositeRequest {
  /** Hex; the octets the attester was challenged with, verbatim. */
  freshnessInput: string;
  /** Unpadded base64url of the prepared Target octets. */
  target: string;
  /** Unpadded base64url of the retrieval subject (DER SubjectPublicKeyInfo). */
  subject: string;
  trustedRoots: string[];
  now: string;
  /** Milliseconds; absent disables the signed-object freshness check. */
  maxEvidenceAge?: number;
  /** Image identities the relying party accepts besides the registry's. */
  referenceValues?: string[];
  /**
   * Image identities Super Protocol's signed-measurement registry vouches
   * for. An appraiser that derives the identity itself has to ask who vouches
   * for it, so the case answers rather than the appraiser assuming.
   */
  registrySignedMeasurements?: string[];
}

export interface CompositeExpectation {
  ok: boolean;
  stage?: ClaimStage;
  reasonContains?: string;
  /** The whole `SwarmClaims` document, compared member by member. */
  claims: Record<string, unknown>;
  /** Why a per-profile override differs. Documentation, never asserted. */
  note?: string;
  /** Overrides for the named appraiser profiles; absent means "the same". */
  appraisers?: Record<string, CompositeExpectation>;
}

export interface CompositeCase {
  id: string;
  description: string;
  request: CompositeRequest;
  /** Path under `vectors/` of the CMW collection this case presents. */
  evidenceFile: string;
  /** Path under `vectors/` of the recorded quote appraisal. */
  appraisalFile: string;
  expect: CompositeExpectation;
}

export interface CompositeManifest {
  version: string;
  description: string;
  generator: string;
  referenceNow: string;
  rootsFile: string;
  appraisers: AppraiserProfile[];
  cases: CompositeCase[];
}

/** A quote appraisal in the claim set's own spelling. */
export interface RecordedAppraisal {
  /** Set when the appraiser could not reach an answer; nothing else counts then. */
  error?: string;
  platform?: SwarmPlatform;
  quote_verified: boolean;
  tcb_status?: string;
  collateral_checked: boolean;
  key_binding: boolean;
  network_type?: string;
  /** Hex of the guest-chosen field, and which field it was read from. */
  binding_data?: string;
  binding_data_source?: 'report-data' | 'hcl-user-data';
  measurements?: Record<string, string>;
  platform_security?: Record<string, unknown>;
  mrenclave?: string;
  mrenclave_approved: boolean;
  mrenclave_source?: string;
  spvm_build?: string;
}

export interface CompositeAppraisalFile {
  description: string;
  root: RecordedAppraisal;
  quote: RecordedAppraisal;
  /**
   * Per appraiser profile, that Verifier's own answer about this case's
   * quote, keyed by the lowercase hex SHA-256 of the serialised TeeEvidence
   * it appraises. An empty map is a coverage limit: the delegated path denies
   * before it asks a Verifier anything.
   *
   * Only the per-request quote is recorded. The membership root's embedded
   * quote is appraised offline on the delegated path too — it is part of the
   * Super Swarm chain rather than of the credential request.
   */
  eat?: Record<string, { tokens: Record<string, string> }>;
}

/** The recorded root-quote appraisal the bundle corpus's `claims` are written against. */
export interface RootQuoteAppraisalFile {
  version: string;
  description: string;
  appraiser: string;
  appraisal: RecordedAppraisal;
}

export function loadCompositeManifest(): CompositeManifest {
  return readVector<CompositeManifest>(`${COMPOSITE_DIR}/manifest.json`);
}

export function loadCompositeTrustedRoots(): TrustedRootVector[] {
  return readVector<TrustedRootsFile>(`${COMPOSITE_DIR}/roots.json`).roots;
}

/** The CMW collection a composite case presents, exactly as the file carries it. */
export function loadCompositeEvidence(testCase: CompositeCase): Record<string, unknown> {
  return readVector<Record<string, unknown>>(testCase.evidenceFile);
}

/** The recorded quote appraisal a composite case is appraised against. */
export function loadCompositeAppraisal(testCase: CompositeCase): CompositeAppraisalFile {
  return readVector<CompositeAppraisalFile>(testCase.appraisalFile);
}

export function loadRootQuoteAppraisal(): RootQuoteAppraisalFile {
  return readVector<RootQuoteAppraisalFile>('root-quote-appraisal.json');
}
