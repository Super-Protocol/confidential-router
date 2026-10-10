/**
 * What `serve.ts` tells a browser-driven suite about the stack it started.
 *
 * A separate module so both sides — the server that writes it and the Playwright
 * project that reads it — are held to the same shape by the compiler.
 */
import { join } from 'node:path';
import { REPO_ROOT } from './router-process.js';

/** Under `test-output/`, which is already ignored and already the artefact root. */
export const HANDOFF_FILE = join(REPO_ROOT, 'test-output', 'demo-stack.json');

/** Where `serve.ts` drops the root a gatekeeper has to trust, for `--pem-file`. */
export const TRUSTED_ROOT_FILE = join(REPO_ROOT, 'test-output', 'demo-cloud-root.pem');

/**
 * The router's log, mirrored here by `serve.ts`. The console mailer writes
 * every sign-in code to it, which is how a browser suite reads the mail a real
 * visitor would open (SUP-269).
 */
export const ROUTER_LOG_FILE = join(REPO_ROOT, 'test-output', 'demo-router.log');

export interface StackHandoff {
  /** Loopback address of the router, for a request made from Node. */
  apiBaseUrl: string;
  /**
   * The origin the *browser* is pointed at. A separate hostname from the
   * console's, so cookies are kept apart exactly as they are on a deployment
   * (SUP-113); it resolves to the same loopback address as `apiBaseUrl`.
   */
  apiOrigin: string;
  consoleOrigin: string;
  /** {@link ROUTER_LOG_FILE} — where a suite finds the sign-in code mailed to an address. */
  routerLogFile: string;
  /** `cr_session=…`, exactly as a browser would hold it. */
  sessionCookie: string;
  /** The same, for the operator in `auth.adminEmails` — a different person from {@link email}. */
  adminSessionCookie: string;
  adminEmail: string;
  workspaceId: string;
  email: string;
  /** Plaintext `/v1` credential. Test material; the stack is thrown away after. */
  apiKeySecret: string;
  apiKeyId: string;
  evidenceDigest: string;
  endpointHostname: string;
  /** `https://<hostname>:<port>` — what an endpoint's `--upstream` is set to. */
  evidenceHostUrl: string;
  /** Copy of {@link TRUSTED_ROOT_FILE}, so a reader has one path to point at. */
  trustedRootFile: string;
  balanceMicros: number;
  /**
   * The registered external upstream, when the stack was started with one
   * (`CR_DEMO_EXTERNAL=1`). Absent otherwise, and a suite that needs it should
   * say so rather than read `undefined` into a selector.
   */
  external?: ExternalHandoff;
}

/**
 * A model endpoint in another deployment, already admitted and already
 * inspectable (ADR-008).
 *
 * Everything here is read back from the product after the fact rather than
 * assumed: the status and the digest come from the admin API, and the digest is
 * the one the *admitting verdict* saw — which is the key the raw-bundle relay
 * answers on, and therefore the only digest a browser inspecting this upstream
 * can expect to see (ADR-008 §7).
 */
export interface ExternalHandoff {
  /** `external_endpoints.name`, and the key of `GET /v1/evidence/{endpoint}`. */
  endpointName: string;
  /** The upstream's own hostname, as the panel's provenance row names it. */
  hostname: string;
  /** `https://<hostname>:<port>` — the upstream's OpenAI-compatible surface. */
  upstreamUrl: string;
  /** The public model id this router publishes for it, as the chat picker shows. */
  modelId: string;
  modelName: string;
  /** `ExternalEndpoint.evidenceDigestSeen`, `sha256/<base64url>`. */
  evidenceDigest: string;
  /** `ExternalEndpoint.measurementSeen` — the cloud the admin's list admitted. */
  measurement: string;
  /** The address `auth.adminEmails` carries; deliberately not the browser's session. */
  adminEmail: string;
}
