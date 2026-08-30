/**
 * Wire types of the unified `/.well-known/swarm-evidence` contract.
 *
 * Ported from Super-Protocol/swarm-cloud `libs/swarm-attestation/src/types.ts`
 * (BSL-1.1) with permission; see the repository NOTICE.
 */

export type EvidenceKind = 'DeploymentEvidence' | 'ControlPlaneEvidence' | 'KubernetesControlPlaneEvidence';

export type RootCaTeeQuoteFormat = 'intel-tdx-quote-v5' | 'amd-sev-snp-report';

export interface RootCaTeeQuote {
  format: RootCaTeeQuoteFormat;
  data: string;
  collateral?: Record<string, unknown>;
}

export interface AttestationBundle {
  version: '1';
  kind: EvidenceKind;
  hostname: string;
  issuedAt: string;
  certFingerprint: string;
  jws: string;
  certChain: string[];
  rootCaTeeQuote?: RootCaTeeQuote;
  /**
   * Optional PEM of the live TLS leaf certificate served on this host. Producers
   * publish the same auto-ssl leaf they fingerprint into `payload.certFingerprint`
   * so verifiers without channel access can still bind the JWS to a concrete TLS
   * cert — see `channelBinding: 'producer-asserted'` in {@link VerifyOk}. Verifiers
   * with channel access (the Go gatekeeper) ignore this field and prefer the live
   * observed leaf.
   */
  tlsLeaf?: string;
}

export interface DeploymentEvidencePayload {
  version: '1';
  kind: 'DeploymentEvidence';
  hostname: string;
  issuedAt: string;
  certFingerprint: string;
  evidenceDigest: string;
  evidence?: unknown;
}

export interface ControlPlaneEvidencePayload {
  version: '1';
  kind: 'ControlPlaneEvidence';
  hostname: string;
  issuedAt: string;
  certFingerprint: string;
  topologyDigest: string;
  topology?: unknown;
}

export interface KubernetesControlPlaneTopologyEntry {
  nodeId: string;
  role: 'server' | 'agent';
  wgIp: string | null;
  tee?: 'tdx' | 'sev-snp' | null;
  nodeCertFingerprint?: string | null;
}

export interface KubernetesControlPlaneEvidencePayload {
  version: '1';
  kind: 'KubernetesControlPlaneEvidence';
  hostname: string;
  issuedAt: string;
  certFingerprint: string;
  rke2Version: string;
  installHash: string;
  kubeSystemDigest: string;
  // Optional pass-through body — the verifier only enforces the base shape, but
  // consumers may render these.
  clusterId?: string;
  imageDigests?: Record<string, string[]>;
  topology?: KubernetesControlPlaneTopologyEntry[];
  kubeSystemSnapshot?: unknown;
  collectedAt?: string;
}

export type EvidencePayload =
  | DeploymentEvidencePayload
  | ControlPlaneEvidencePayload
  | KubernetesControlPlaneEvidencePayload;

export interface TrustedRoot {
  name: string;
  pem: string;
}

export type VerifyStage = 'fetch' | 'cert-chain' | 'untrusted-root' | 'jws' | 'tls-fingerprint';

/**
 * Parameters for {@link verifyHostname}.
 *
 * `observedTlsFingerprint` is optional. There are two channel-binding modes:
 *
 *   - **observed** — caller supplies `observedTlsFingerprint` from the live TLS
 *     channel (the gatekeeper's own handshake, server-side checks). The verifier
 *     compares it against `payload.certFingerprint`. This is the strongest binding
 *     and is preferred whenever channel access is available; it is the only mode
 *     the gatekeeper uses (ADR-003 §1).
 *
 *   - **producer-asserted** — caller omits `observedTlsFingerprint` and the bundle
 *     carries `tlsLeaf`. The verifier hashes `tlsLeaf` and compares against
 *     `payload.certFingerprint`. The trust boundary is "producer asserts this PEM
 *     is what it serves on TLS, and JWS-signs that assertion" — anyone holding the
 *     JWS signing key could lie, but that is the same trust boundary as the rest of
 *     the bundle.
 *
 * If neither is present, verification fails at stage `'tls-fingerprint'`.
 */
export interface VerifyParams {
  hostname: string;
  observedTlsFingerprint?: string;
  trustedRoots: TrustedRoot[];
  fetcher?: typeof fetch;
  now?: Date;
  cache?: VerifyCache;
  /**
   * Maximum acceptable age, in milliseconds, of `payload.issuedAt` relative to `now`.
   * When set, bundles older than the window are rejected with `stage: 'jws'`. Bundles
   * dated noticeably in the future (beyond a small clock-skew tolerance) are also
   * rejected. Leave undefined to skip the check entirely.
   */
  maxBundleAge?: number;
}

export type ChannelBinding = 'observed' | 'producer-asserted';

export interface VerifyOk {
  ok: true;
  kind: EvidenceKind;
  payload: EvidencePayload;
  matchedRoot: { name: string; fingerprint: string };
  rootCaTeeQuote?: RootCaTeeQuote;
  /**
   * How the JWS-signed `payload.certFingerprint` was bound to a concrete TLS leaf.
   * `'observed'` means the caller supplied a live-channel fingerprint;
   * `'producer-asserted'` means the bundle carried `tlsLeaf` and the verifier
   * hashed it itself.
   */
  channelBinding: ChannelBinding;
}

export interface VerifyErr {
  ok: false;
  stage: VerifyStage;
  reason: string;
}

export type VerifyResult = VerifyOk | VerifyErr;

export interface VerifyCache {
  get(key: string): VerifyResult | undefined;
  set(key: string, value: VerifyResult): void;
}
