import {
  CertChainError,
  type EvidencePayload,
  fingerprintsEqual,
  type ParsedChain,
  type RootAttestation,
  type RootEvidenceType,
  type RootNetworkType,
  type RootReportSecurity,
  readRootAttestation,
  rootFingerprintFromPem,
  sha256Fingerprint,
  validateChain,
  verifyJws,
} from '@confidential-router/attestation';
import { isMeasurementHex, lookUpMeasurement, type RegistryVerdict } from './sp-vm-registry';

/** The chain leaf and root, without naming `@peculiar/x509` in this file at all. */
type ChainLeaf = ParsedChain['leaf'];
type ChainRoot = ParsedChain['root'];

/**
 * Tier 1 of the chat's verification: the page checks the endpoint's evidence
 * itself, in the visitor's browser, before the composer will send anything.
 *
 * It runs the same TypeScript verifier the Chrome extension runs
 * (`@confidential-router/attestation`, which is the swarm-cloud
 * `swarm-attestation` port) — but as individual stages rather than through
 * `verifyHostname`, for one reason that matters: `verifyHostname` answers "does
 * this chain terminate at a root in my trust store", and a page served *by the
 * deployment it is checking* has no independent trust store to answer that with.
 * Pinning the root out of the very bundle under test would be a green tick that
 * proves nothing.
 *
 * So the root question is asked of something outside the deployment instead: the
 * signed sp-vm measurement registry (`sp-vm-registry.ts`), under a key pinned in
 * this bundle.
 *
 * That lookup needs a measurement in the form the registry indexes, and on the
 * live platform there is none to be had from a browser. `rootCaTeeQuote` is a
 * `{"status":"not-implemented"}` placeholder, and the real quote — a full SEV-SNP
 * report — sits in the root certificate's TEE-evidence extension, indexed under a
 * *normalised launch digest* that only a rebuild from the release's firmware image
 * produces. So the root check reports `unavailable` here, and the thing that
 * matters is what it says while doing so.
 *
 * It used to say the platform published no quote for the hostname, which was
 * false, and it said nothing about Gatekeeper reaching a different verdict on the
 * very endpoint the composer had just been unlocked for (SUP-185). It now reads
 * the extension (`readRootAttestation`), reports what is actually in it —
 * including whether the report commits to the root's own key, which a page *can*
 * check — and names the gap it cannot close. It never reports a pass it did not
 * get, and it no longer reports an absence it did not observe.
 *
 * What a pass here does and does not mean is spelled out in `tiers.ts`, which
 * owns every user-visible string. Nothing in this file is allowed to say
 * "verified" on its own.
 */

/** Rejected past this age, like the extension: producers republish every few minutes. */
export const MAX_BUNDLE_AGE_MS = 24 * 60 * 60 * 1000;

/** Producer and verifier clocks are allowed to disagree by this much. */
export const ALLOWED_CLOCK_SKEW_MS = 60_000;

export const EVIDENCE_PATH = '/.well-known/swarm-evidence';

export type CheckId = 'webcrypto' | 'bundle' | 'chain' | 'signature' | 'freshness' | 'binding' | 'root';

export type CheckStatus = 'pass' | 'fail' | 'unavailable';

export interface GateCheck {
  id: CheckId;
  status: CheckStatus;
  /** One sentence, written for the viewer, stating what was established. */
  detail: string;
}

/**
 * Where the bundle came from.
 *
 * `endpoint` is a direct fetch of the host's own `/.well-known/swarm-evidence`;
 * `router` is this router's unauthenticated passthrough of the last bundle it
 * retrieved. The signature is checked either way, so a bundle from the router
 * cannot be forged — but it can be *older* than what the host serves now, and a
 * viewer comparing digests with a gatekeeper deserves to know which they are
 * looking at.
 */
export type BundleSource = 'endpoint' | 'router';

/**
 * One certificate of the published chain, as the inspector lists it.
 *
 * Summarised here rather than in the panel because the certificates themselves
 * are `@peculiar/x509` objects the gate already holds and the panel should never
 * need to parse: everything downstream reads strings.
 */
export interface GateCertificate {
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  /** `sha256/<base64url>` of the DER — the form the bundle and Gatekeeper use. */
  fingerprint: string;
  /** True for the terminal, self-signed certificate: the TEE-quoted root. */
  isRoot: boolean;
}

export interface GateEvidence {
  hostname: string;
  source: BundleSource;
  issuedAt: string;
  /** The payload's own `kind`; a router endpoint publishes DeploymentEvidence. */
  kind: EvidencePayload['kind'];
  evidenceDigest: string | null;
  certFingerprint: string;
  /**
   * The *signed* deployment snapshot, verbatim — `payload.evidence` of the JWS
   * this page just verified, not a copy fetched from anywhere else.
   *
   * This is what the deployment graph is drawn from, and the reason it is
   * carried here rather than re-requested: the graph is meant to *be* the
   * attested document rather than an illustration beside it, and a second fetch
   * would be a second thing that can disagree. `undefined` when the producer
   * published a digest without the snapshot behind it, which the contract allows
   * and which the panel reports as "nothing to draw" rather than as a failure.
   */
  snapshot: unknown;
  /** The compact JWS as published, so a reader can take the signed bytes away. */
  jws: string;
  /** Every certificate of the published chain, leaf → root. */
  chain: GateCertificate[];
  rootSubject: string | null;
  rootFingerprint: string | null;
  /** `rootCaTeeQuote.format`, or null when the platform published no usable quote. */
  quoteFormat: string | null;
  /** The measurement the registry was asked about, when the bundle published one. */
  measurement: string | null;
  /**
   * What the root certificate's own extensions say about the VM that enrolled it.
   *
   * Separate from `quoteFormat`, and the more informative of the two: the live
   * platform leaves `rootCaTeeQuote` a placeholder and puts the real report here.
   */
  rootEvidenceLabel: string | null;
  /** The sp-vm release the root's VM booted, when its evidence names one. */
  rootBuild: string | null;
  /** Whether the root's quote commits to the root's own key; null when undecided. */
  rootKeyBinding: boolean | null;
  /** The Super Protocol network the root declares. Reported, never enforced. */
  rootNetworkType: RootNetworkType | null;
  /** Which hardware branch the root's evidence carries, when it carries one. */
  rootEvidenceType: RootEvidenceType | null;
  /** Verbatim enrolment-challenge extension, e.g. `sev-snp`. */
  rootChallengeType: string | null;
  /**
   * The report's own 48-byte `MEASUREMENT`, hex. Shown because it is the
   * report's headline field — and explicitly *not* the registry lookup key; see
   * `measurementOf`.
   */
  rootReportMeasurement: string | null;
  /** The root report's policy and TCB fields, when they could be read. */
  rootSecurity: RootReportSecurity | null;
  /** Why an extension that is present could not be used. */
  rootAttestationError: string | null;
}

export interface GateResult {
  /** True when every check the page can run passed. The composer reads this. */
  unlocked: boolean;
  checks: GateCheck[];
  registry: RegistryVerdict | null;
  evidence: GateEvidence | null;
}

export interface GateOptions {
  hostname: string;
  /** Endpoint *name*, for the router's `GET /v1/evidence/:endpoint` fallback. */
  endpointName: string;
  /** router-api's origin, for that fallback. */
  apiOrigin: string;
  fetcher?: typeof fetch;
  now?: Date;
  /** Skips the network in tests; also the seam the extension bridge does not use. */
  registryLookup?: typeof lookUpMeasurement;
  /**
   * Reads the root's attestation extensions. A seam only because the branches it
   * selects between are the point of the root row, and the fixture PKI's roots
   * carry no such extensions — the reader itself is held to a real Super Swarm
   * root in `libs/attestation`.
   */
  rootAttestationReader?: typeof readRootAttestation;
}

/**
 * The checks that must come back `pass` before the composer unlocks.
 *
 * `webcrypto` is absent on purpose: it is answered before any of these, by
 * returning early, so it never reaches this list — and adding it here would make
 * every happy path fail for want of a row nothing emits.
 *
 * `root` is absent for a different reason, and `mustNotHaveFailed` below is the
 * other half of the rule: a row the page *could not answer* must not hold the
 * composer, or a gap on the platform's side locks the demo surface for good.
 */
const BLOCKING: readonly CheckId[] = ['bundle', 'chain', 'signature', 'freshness', 'binding'];

/**
 * Whether the composer may open.
 *
 * Two clauses, because "not established" and "answered no" are different things
 * and this is the one place the difference has teeth:
 *
 *  - every check in {@link BLOCKING} came back `pass`, and
 *  - **no** check came back `fail`.
 *
 * The second clause is what `root` needs. Leaving it out was the other half of
 * SUP-185: the row could show a cross reading "Do not trust this endpoint on the
 * strength of this page" while the badge above it read "Verified by this page" and
 * the composer sat open — the screen holding a negative it had proven itself and
 * saying its strongest sentence over it. `unavailable` still never blocks, so the
 * live platform, where the registry step is simply out of a browser's reach, keeps
 * its unlocked composer and its disclosure.
 *
 * Stated as a principle rather than as `root`-when-failed because that is what it
 * is: a check that came back negative blocks; a check nobody could answer does
 * not. For the rows in `BLOCKING` it changes nothing — they return early on
 * failure — so `root` is the only row it reaches today, and a later informational
 * row that can genuinely fail gets the safe default rather than a silent pass.
 */
function unlocks(checks: readonly GateCheck[]): boolean {
  const blockingPassed = BLOCKING.every((id) => checks.find((check) => check.id === id)?.status === 'pass');
  const mustNotHaveFailed = !checks.some((check) => check.status === 'fail');
  return blockingPassed && mustNotHaveFailed;
}

export async function runEvidenceGate(options: GateOptions): Promise<GateResult> {
  /*
   * Web Crypto first, because without it there is no verifier at all.
   *
   * Browsers expose `crypto.subtle` only in a secure context: HTTPS, or
   * `http://localhost`. A console served over plain HTTP on any *named* host —
   * a developer's `http://console.localtest.me:4300`, an operator's internal
   * hostname — therefore cannot verify anything, and every signature check below
   * would fail with "SubtleCrypto is not available", which reads as though the
   * deployment's evidence were bad. It is not: it is this page that cannot look.
   * Saying which is the whole point of the tier.
   */
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    return {
      unlocked: false,
      checks: [
        {
          id: 'webcrypto',
          status: 'fail',
          detail:
            'This page is not served over a secure origin, so the browser withholds the Web Crypto API that ' +
            'verifying evidence needs. Nothing here has been checked — and nothing will be sent. Open the console ' +
            'over HTTPS, or on http://localhost, which browsers treat as secure.',
        },
      ],
      registry: null,
      evidence: null,
    };
  }

  const fetched = await fetchBundle(options);
  if (!fetched.ok) {
    return {
      unlocked: false,
      checks: [{ id: 'bundle', status: 'fail', detail: fetched.detail }],
      registry: null,
      evidence: null,
    };
  }

  const { bundle, source } = fetched;
  const checks: GateCheck[] = [
    {
      id: 'bundle',
      status: 'pass',
      detail:
        source === 'endpoint'
          ? `The host served a swarm-evidence v1 bundle for ${bundle.hostname}.`
          : `This router handed back the last bundle it retrieved for ${bundle.hostname}.`,
    },
  ];

  const chain = await checkChain(bundle, options.now);
  checks.push(chain.check);
  if (!chain.ok) {
    return { unlocked: false, checks, registry: null, evidence: null };
  }

  const signature = await checkSignature(bundle, chain.leaf);
  checks.push(signature.check);
  if (!signature.ok) {
    return { unlocked: false, checks, registry: null, evidence: null };
  }

  const payload = signature.payload;
  checks.push(checkFreshness(payload.issuedAt, options.now));
  checks.push(await checkBinding(payload.certFingerprint, bundle.tlsLeaf));

  const measurement = measurementOf(payload, bundle);
  const attestation = await (options.rootAttestationReader ?? readRootAttestation)(chain.root);
  const root = await checkRoot({
    quote: bundle.rootCaTeeQuote,
    measurement,
    rootSubject: chain.rootSubject,
    attestation,
    lookUp: options.registryLookup ?? lookUpMeasurement,
    fetcher: options.fetcher,
  });
  checks.push(root.check);

  return {
    unlocked: unlocks(checks),
    checks,
    registry: root.registry,
    evidence: {
      hostname: bundle.hostname,
      source,
      issuedAt: payload.issuedAt,
      kind: payload.kind,
      evidenceDigest: 'evidenceDigest' in payload ? (payload.evidenceDigest as string) : null,
      certFingerprint: payload.certFingerprint,
      // The verified payload's own member, not the envelope's and not a refetch.
      snapshot: 'evidence' in payload ? payload.evidence : undefined,
      jws: bundle.jws,
      chain: chain.summary,
      rootSubject: chain.rootSubject,
      rootFingerprint: chain.rootFingerprint,
      quoteFormat: quoteFormatOf(bundle.rootCaTeeQuote),
      measurement,
      rootEvidenceLabel: attestation.evidence?.label ?? null,
      rootBuild: attestation.evidence?.build ?? null,
      rootKeyBinding: attestation.evidence?.keyBinding ?? null,
      rootNetworkType: attestation.networkType,
      rootEvidenceType: attestation.evidence?.type ?? null,
      rootChallengeType: attestation.challengeType,
      rootReportMeasurement: attestation.evidence?.reportMeasurement ?? null,
      rootSecurity: attestation.evidence?.security ?? null,
      rootAttestationError: attestation.error,
    },
  };
}

interface RawBundle {
  version: string;
  kind: string;
  hostname: string;
  issuedAt: string;
  certFingerprint: string;
  jws: string;
  certChain: string[];
  rootCaTeeQuote?: unknown;
  tlsLeaf?: string;
}

type FetchOutcome = { ok: true; bundle: RawBundle; source: BundleSource } | { ok: false; detail: string };

/**
 * The host first, this router second.
 *
 * A direct fetch is the better evidence and is what a gatekeeper would do, but it
 * is a cross-origin request to a host that does not have to allow one — so a CORS
 * refusal must degrade to the router's passthrough rather than leaving the screen
 * unable to verify anything. Which one answered is recorded and shown.
 */
async function fetchBundle(options: GateOptions): Promise<FetchOutcome> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== 'function') {
    return { ok: false, detail: 'This browser exposes no fetch, so no evidence could be retrieved.' };
  }

  const direct = await tryFetch(fetcher, `https://${options.hostname}${EVIDENCE_PATH}`, options.hostname);
  if (direct.ok) {
    return { ok: true, bundle: direct.bundle, source: 'endpoint' };
  }

  const base = options.apiOrigin.replace(/\/+$/, '');
  const relayed = await tryFetch(
    fetcher,
    `${base}/v1/evidence/${encodeURIComponent(options.endpointName)}`,
    options.hostname,
  );
  if (relayed.ok) {
    return { ok: true, bundle: relayed.bundle, source: 'router' };
  }

  return {
    ok: false,
    detail: `No evidence could be retrieved for ${options.hostname}: the host answered "${direct.detail}" and this router answered "${relayed.detail}".`,
  };
}

async function tryFetch(
  fetcher: typeof fetch,
  url: string,
  expectedHostname: string,
): Promise<{ ok: true; bundle: RawBundle } | { ok: false; detail: string }> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
  if (!response.ok) {
    return { ok: false, detail: `status ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, detail: `body is not JSON (${(error as Error).message})` };
  }
  return shapeOf(body, expectedHostname);
}

/**
 * The bundle's envelope shape, mirroring `schemas/swarm-evidence-bundle.schema.json`.
 *
 * Strict about the hostname and the members the verification stages consume, and
 * deliberately loose about `rootCaTeeQuote`: the demo cloud publishes a
 * placeholder object there, and a display field must not be able to fail a
 * bundle a gatekeeper would admit (SUP-157).
 */
function shapeOf(
  raw: unknown,
  expectedHostname: string,
): { ok: true; bundle: RawBundle } | { ok: false; detail: string } {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, detail: 'the response is not a JSON object' };
  }
  const value = raw as Record<string, unknown>;
  if (value.version !== '1') {
    return { ok: false, detail: `unsupported bundle version ${String(value.version)}` };
  }
  if (value.kind !== 'DeploymentEvidence') {
    return { ok: false, detail: `unsupported bundle kind ${String(value.kind)}` };
  }
  if (value.hostname !== expectedHostname) {
    return { ok: false, detail: `the bundle names ${String(value.hostname)}, not ${expectedHostname}` };
  }
  if (typeof value.jws !== 'string' || value.jws.length === 0) {
    return { ok: false, detail: 'the bundle carries no JWS' };
  }
  if (typeof value.certFingerprint !== 'string' || !value.certFingerprint.startsWith('sha256/')) {
    return { ok: false, detail: 'the bundle certFingerprint is malformed' };
  }
  if (
    !Array.isArray(value.certChain) ||
    value.certChain.length === 0 ||
    !value.certChain.every((pem) => typeof pem === 'string' && pem.length > 0)
  ) {
    return { ok: false, detail: 'the bundle carries no certificate chain' };
  }
  if (typeof value.issuedAt !== 'string') {
    return { ok: false, detail: 'the bundle carries no issuedAt' };
  }

  return {
    ok: true,
    bundle: {
      version: '1',
      kind: 'DeploymentEvidence',
      hostname: value.hostname,
      issuedAt: value.issuedAt,
      certFingerprint: value.certFingerprint,
      jws: value.jws,
      certChain: value.certChain as string[],
      rootCaTeeQuote: value.rootCaTeeQuote,
      tlsLeaf: typeof value.tlsLeaf === 'string' ? value.tlsLeaf : undefined,
    },
  };
}

type ChainOutcome =
  | {
      ok: true;
      check: GateCheck;
      leaf: ChainLeaf;
      root: ChainRoot;
      rootSubject: string;
      rootFingerprint: string;
      summary: GateCertificate[];
    }
  | { ok: false; check: GateCheck };

/**
 * Subject, issuer, validity and fingerprint of each certificate the chain check
 * just validated, leaf → root.
 *
 * Fingerprints are computed rather than copied out of the bundle, which
 * publishes only the leaf's: the point of listing the chain is that a reader can
 * compare the terminal value with the root their own Gatekeeper trusts, and a
 * value this page derived from the DER it validated is the one that means
 * something.
 */
async function summariseChain(parsed: ParsedChain): Promise<GateCertificate[]> {
  return Promise.all(
    parsed.certs.map(async (certificate, index) => ({
      subject: certificate.subject,
      issuer: certificate.issuer,
      notBefore: certificate.notBefore.toISOString(),
      notAfter: certificate.notAfter.toISOString(),
      fingerprint: await sha256Fingerprint(new Uint8Array(certificate.rawData)),
      isRoot: index === parsed.certs.length - 1,
    })),
  );
}

async function checkChain(bundle: RawBundle, now: Date | undefined): Promise<ChainOutcome> {
  try {
    const parsed = await validateChain(bundle.certChain, { now });
    return {
      ok: true,
      leaf: parsed.leaf,
      root: parsed.root,
      rootSubject: parsed.root.subject,
      rootFingerprint: parsed.rootFingerprint,
      summary: await summariseChain(parsed),
      check: {
        id: 'chain',
        status: 'pass',
        detail: `Each certificate signs the next, all are inside their validity window, and the chain terminates at the self-signed root ${parsed.root.subject}.`,
      },
    };
  } catch (error) {
    const message = error instanceof CertChainError ? error.message : (error as Error).message;
    return {
      ok: false,
      check: { id: 'chain', status: 'fail', detail: `The certificate chain is not valid: ${message}` },
    };
  }
}

type SignatureOutcome = { ok: true; check: GateCheck; payload: EvidencePayload } | { ok: false; check: GateCheck };

async function checkSignature(bundle: RawBundle, leaf: ChainLeaf): Promise<SignatureOutcome> {
  try {
    const payload = await verifyJws(bundle.jws, leaf);
    if (payload.hostname !== bundle.hostname) {
      return {
        ok: false,
        check: {
          id: 'signature',
          status: 'fail',
          detail: `The signed payload names ${payload.hostname}, not ${bundle.hostname}.`,
        },
      };
    }
    return {
      ok: true,
      payload,
      check: {
        id: 'signature',
        status: 'pass',
        detail: 'The evidence is signed by the key in the chain leaf, and the signed payload names this hostname.',
      },
    };
  } catch (error) {
    return {
      ok: false,
      check: { id: 'signature', status: 'fail', detail: `The signature did not verify: ${(error as Error).message}` },
    };
  }
}

function checkFreshness(issuedAt: string, now: Date | undefined): GateCheck {
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued)) {
    return { id: 'freshness', status: 'fail', detail: `The signed issuedAt "${issuedAt}" is not a timestamp.` };
  }
  const age = (now ?? new Date()).getTime() - issued;
  if (age > MAX_BUNDLE_AGE_MS) {
    return {
      id: 'freshness',
      status: 'fail',
      detail: `The evidence was signed ${Math.floor(age / 3_600_000)} hours ago, past the 24-hour window. A healthy deployment republishes every few minutes.`,
    };
  }
  if (age < -ALLOWED_CLOCK_SKEW_MS) {
    return {
      id: 'freshness',
      status: 'fail',
      detail: 'The evidence is dated in the future beyond allowed clock skew.',
    };
  }
  return {
    id: 'freshness',
    status: 'pass',
    detail: `The evidence was signed ${describeAge(age)} and is inside the 24-hour freshness window.`,
  };
}

/**
 * Producer-asserted channel binding, which is the only kind a page can do.
 *
 * A gatekeeper compares the signed `certFingerprint` with the certificate it
 * observes on its own TLS connection. A browser page cannot see that
 * certificate, so it does the next best thing the contract allows: hash the
 * `tlsLeaf` the producer publishes and check it against the signed fingerprint.
 * The trust boundary is "the producer asserts this is what it serves, and signs
 * that assertion" — strictly weaker, and labelled as such.
 */
async function checkBinding(signedFingerprint: string, tlsLeafPem: string | undefined): Promise<GateCheck> {
  if (!tlsLeafPem) {
    return {
      id: 'binding',
      status: 'fail',
      detail:
        'The bundle publishes no tlsLeaf, so the signed certificate fingerprint cannot be tied to any certificate from inside a browser.',
    };
  }
  try {
    // `rootFingerprintFromPem` is named for the job it was written for, but it is
    // just "PEM in, sha256/<base64url> out" — the same transform the fingerprint
    // in the signed payload was produced by.
    const derived = await rootFingerprintFromPem(tlsLeafPem);
    if (!fingerprintsEqual(signedFingerprint, derived)) {
      return {
        id: 'binding',
        status: 'fail',
        detail: `The published TLS certificate hashes to ${derived}, but the evidence signs ${signedFingerprint}.`,
      };
    }
    return {
      id: 'binding',
      status: 'pass',
      detail:
        'The TLS certificate the deployment publishes hashes to the fingerprint the evidence signs. This is a producer-asserted binding: a page cannot inspect the live TLS certificate, so it checks what the deployment says it serves.',
    };
  } catch (error) {
    return {
      id: 'binding',
      status: 'fail',
      detail: `The published tlsLeaf could not be parsed: ${(error as Error).message}`,
    };
  }
}

/**
 * Whether the root this chain terminates at belongs to a VM Super Protocol
 * vouches for — the one question the page cannot answer out of the bundle itself.
 *
 * Several things can be true, and they are different sentences. Saying the wrong
 * one is not a cosmetic defect on this screen: the row is the only place a reader
 * is told what the green badge above it does *not* cover, so a row that blames the
 * platform for an absence, where the real state is "the quote is here and I cannot
 * finish the check", spends the reader's trust on a false claim (SUP-185).
 *
 * One of them is a refusal, and it is settled before any of the others: see
 * `liftedEvidenceRefusal`.
 */
async function checkRoot(input: {
  quote: unknown;
  measurement: string | null;
  rootSubject: string;
  attestation: RootAttestation;
  lookUp: typeof lookUpMeasurement;
  fetcher: typeof fetch | undefined;
}): Promise<{ check: GateCheck; registry: RegistryVerdict | null }> {
  const lifted = liftedEvidenceRefusal(input.rootSubject, input.attestation, input.measurement !== null);
  if (lifted) {
    return { registry: null, check: lifted };
  }

  if (!input.measurement) {
    return { registry: null, check: rootWithoutLookup(input.quote, input.rootSubject, input.attestation) };
  }

  const verdict = await input.lookUp(input.measurement, { fetcher: input.fetcher });
  if (verdict.status === 'vouched') {
    return {
      registry: verdict,
      check: {
        id: 'root',
        status: 'pass',
        detail: `The measurement ${short(verdict.measurement)} is signed in Super Protocol's published registry under the key pinned in this page, so the VM behind ${input.rootSubject} is a build Super Protocol vouches for.`,
      },
    };
  }
  if (verdict.status === 'not-in-registry') {
    return {
      registry: verdict,
      check: {
        id: 'root',
        status: 'fail',
        detail: `The registry holds no valid signature for measurement ${short(verdict.measurement)}, so this VM is not one Super Protocol vouches for.`,
      },
    };
  }
  return {
    registry: verdict,
    check: {
      id: 'root',
      status: 'unavailable',
      detail: `Super Protocol's measurement registry could not be consulted (${verdict.reason}), so the root is neither confirmed nor rejected.`,
    },
  };
}

/**
 * The measurement to look up, from wherever the producer published it.
 *
 * The bundle contract does not fix a location, so the known ones are tried in
 * order of specificity — the same list `parseEvidenceBundle` reads for the
 * evidence modal — and only a value that is hex of the right length is used.
 *
 * The root certificate's TEE-evidence extension is deliberately *not* a fourth
 * candidate, even though `readRootAttestation` decodes a measurement out of it.
 * That value is the report's own hardware `MEASUREMENT`; the registry is indexed
 * by the normalised launch digest derived from it, and the two differ for every
 * VM. It is the right length and the right alphabet, so `isMeasurementHex` would
 * wave it through and the registry would answer `not-in-registry` — a page
 * telling a reader a healthy deployment is not one Super Protocol vouches for.
 * Only a value a producer published *as* a registry measurement belongs here.
 */
function measurementOf(payload: unknown, bundle: RawBundle): string | null {
  const evidence = (payload as { evidence?: { measurements?: unknown } } | undefined)?.evidence;
  const candidates: unknown[] = [
    evidence?.measurements,
    (payload as { measurements?: unknown }).measurements,
    (bundle.rootCaTeeQuote as { collateral?: { measurements?: unknown } } | undefined)?.collateral?.measurements,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    for (const key of ['mrenclave', 'mrEnclave', 'MRENCLAVE']) {
      const value = (candidate as Record<string, unknown>)[key];
      if (typeof value === 'string' && isMeasurementHex(value.trim().toLowerCase())) {
        return value.trim().toLowerCase();
      }
    }
  }
  return null;
}

/**
 * The one negative this row can establish on its own, and the only answer that
 * outranks the registry.
 *
 * The quote in the root certificate attests some *other* public key: either the
 * certificate is not the one the VM enrolled, or the quote was lifted from a VM
 * that was. Gatekeeper refuses such a root outright, and this row has to agree —
 * on every path, which is the part that was wrong when this was first written.
 *
 * It used to live inside `rootWithoutLookup`, so it only bound the no-measurement
 * case. A bundle publishing a `mrenclave` the registry vouches for went straight
 * to the lookup and painted the row green — its strongest sentence — while the
 * page already held the proof that the root's own quote says nothing about this
 * key. The published measurement is a producer-controlled string that nothing
 * binds to this root, so it cannot answer the question the quote just failed;
 * checking it would only decide whether *some* VM is vouched for. Hence the guard
 * runs first, and the registry is not consulted at all: there is no verdict it
 * could return that would change this row, and a page that has decided to refuse
 * has no business making another cross-origin request about it.
 */
function liftedEvidenceRefusal(
  rootSubject: string,
  attestation: RootAttestation,
  bundlePublishesMeasurement: boolean,
): GateCheck | null {
  const evidence = attestation.evidence;
  // `undefined !== false` covers the no-evidence case, so this is the whole guard:
  // only a decoded quote that actively failed the binding gets past it.
  if (evidence?.keyBinding !== false) return null;

  // Named explicitly, because a reader looking at a red row on a bundle whose
  // measurement *is* registered deserves to know the registry was not what
  // decided this, and why its answer would not have helped.
  const collision = bundlePublishesMeasurement
    ? ` This bundle also publishes a measurement for the registry to vouch for, which is not an answer to this: a registry entry proves some VM is one of Super Protocol's, not that this root's key is that VM's. It was not consulted.`
    : '';

  return {
    id: 'root',
    status: 'fail',
    detail: `The root ${rootSubject} carries an ${evidence.label} quote, but that quote's report data does not commit to this root's public key — so it attests some other key, not this one.${collision} Do not trust this endpoint on the strength of this page: run Gatekeeper, which refuses a root whose quote does not bind its own key.`,
  };
}

/**
 * What to say when there is no measurement the registry indexes.
 *
 * Never a pass: the registry is the only thing outside the deployment that could
 * answer this, and it has not been asked. But "not established" has to be
 * qualified by *why*, because the reasons differ in what the reader should do
 * next. A root whose quote does not bind its own key never reaches here —
 * `liftedEvidenceRefusal` has already refused it.
 */
function rootWithoutLookup(quote: unknown, rootSubject: string, attestation: RootAttestation): GateCheck {
  const evidence = attestation.evidence;

  if (evidence) {
    /*
     * The live platform. The quote is right here in the root certificate, its
     * report commits to the root's key, and the page still cannot finish: the
     * sp-vm registry is indexed by a *normalised launch digest* — the digest
     * rebuilt page by page from the release's OVMF image and kernel artefacts for
     * a canonical single-core VM, then wrapped — and neither the report's own
     * MEASUREMENT nor anything else in the bundle is that value. Handing the
     * report's measurement to the registry would answer "not one of ours" for a
     * sound VM, which is why it is not done.
     */
    const bound =
      evidence.keyBinding === true ? " and that quote's report data commits to this root's own public key" : '';
    const release = evidence.build ? ` for sp-vm ${evidence.build}` : '';
    return {
      id: 'root',
      status: 'unavailable',
      detail: `The root ${rootSubject} carries an ${evidence.label} quote${release}${bound}. What this page cannot do is the last step: Super Protocol's registry indexes a VM by a launch measurement rebuilt from that release's firmware image, which is not browser work. So nothing here says this VM is one Super Protocol vouches for — and Gatekeeper, which does rebuild it, may reach a different verdict on this endpoint, including refusing it. Tier 3 below is how you find out.`,
    };
  }

  if (attestation.carriesEvidence) {
    // Present but undecodable. Still not an absence, and the reader is owed the
    // distinction: a malformed extension is a platform problem worth reporting,
    // not a hostname that publishes nothing.
    return {
      id: 'root',
      status: 'unavailable',
      detail: `The root ${rootSubject} carries a TEE evidence extension this page could not read (${attestation.error ?? 'unknown reason'}), so nothing here says either way whether this VM is one of Super Protocol's. Run Gatekeeper, which reads the extension in full.`,
    };
  }

  const format = quoteFormatOf(quote);
  if (format) {
    return {
      id: 'root',
      status: 'unavailable',
      detail: `The deployment publishes a ${format} quote but no measurement this page can look up, and the root ${rootSubject} carries no TEE evidence of its own. Nothing here says this VM is one of Super Protocol's. Tiers 2 and 3 answer that.`,
    };
  }

  // The only case where an absence may be asserted — because both places a quote
  // can live have now been looked in, and the sentence says which.
  return {
    id: 'root',
    status: 'unavailable',
    detail: `Neither this bundle's rootCaTeeQuote nor the root certificate ${rootSubject} carries a TEE quote, so nothing here says this VM is one of Super Protocol's. Tiers 2 and 3 answer that.`,
  };
}

function quoteFormatOf(quote: unknown): string | null {
  const format = (quote as { format?: unknown } | undefined)?.format;
  return typeof format === 'string' && format.length > 0 ? format : null;
}

function describeAge(ageMs: number): string {
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

function short(hex: string): string {
  return `${hex.slice(0, 12)}…${hex.slice(-8)}`;
}
