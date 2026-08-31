/**
 * Typed loader for the language-neutral conformance vectors in `../vectors`.
 *
 * The vectors themselves are plain JSON and are the contract: the TypeScript
 * verifier (`@confidential-router/attestation`) and the Go verifier
 * (`apps/gatekeeper/pkg/attestation`) must produce the same verdict for every
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

export type CaseExpectation =
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
