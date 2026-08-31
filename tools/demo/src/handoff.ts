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

export interface StackHandoff {
  apiBaseUrl: string;
  consoleOrigin: string;
  /** `cr_session=…`, exactly as a browser would hold it. */
  sessionCookie: string;
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
}
