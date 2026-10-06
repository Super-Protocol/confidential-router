import { request } from 'node:http';

/**
 * The read side of the seam: router-api polling the sidecar's admin API
 * (ADR-008 §5 step 3).
 *
 * Poll-only, and deliberately so — the gatekeeper's admin API exposes no route
 * that could start, stop or re-attest an endpoint (`pkg/proxy/admin.go`), and we
 * keep that property. Everything router-api wants to *change* it changes by
 * rendering the config file, which is the one write path there is.
 *
 * The types below mirror `pkg/proxy/admin.go` and `pkg/status/status.go` reduced
 * to the fields ADR-008 §6 projects. They are narrow on purpose: the full
 * `status.Report` is large, and a reader that destructured all of it would turn
 * every unrelated core change into a compile error here.
 */

/** `pkg/status/status.go` — the states a listener can be in. */
export type SidecarHealth = 'unknown' | 'stopped' | 'attesting' | 'confidential' | 'non-confidential' | 'broken';

/** The `attestedRoot` evidence behind a root decision, populated even when it denied. */
export interface SidecarAttestedRoot {
  measurement?: string;
  /** `registry` or `operator-pinned` (SUP-139); absent when nothing vouched for it. */
  measurementSource?: string;
  inRegistry?: boolean;
}

/** One verification of one endpoint, as `/verdicts` carries it. */
export interface SidecarReport {
  checkedAt?: string;
  verified?: boolean;
  admitted?: boolean;
  /** ADR-003 §1 stage name of the failure; absent on success. */
  stage?: string;
  reason?: string;
  attestedRoot?: SidecarAttestedRoot;
  /** The leaf the sidecar observed on its own handshake, and pinned on success. */
  observedTlsFingerprint?: string;
  certFingerprint?: string;
  evidenceDigest?: string;
}

/** One entry of `GET /verdicts`. */
export interface SidecarVerdict {
  endpoint: string;
  health: SidecarHealth;
  admitted: boolean;
  reason?: string;
  report?: SidecarReport;
}

export class SidecarUnavailableError extends Error {
  constructor(path: string, reason: string) {
    super(`The egress sidecar's admin API did not answer ${path}: ${reason}.`);
    this.name = 'SidecarUnavailableError';
  }
}

/** One request bounds how long a poll can take; the API only renders state already in memory. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Reads `GET /verdicts` from an `admin.listen` value: `unix:<path>` or a loopback
 * `host:port`.
 *
 * A function rather than a class, because there is no state worth keeping between
 * polls: the last answer is projected into the database, which is where the next
 * poll compares against.
 */
export async function fetchSidecarVerdicts(adminListen: string): Promise<readonly SidecarVerdict[]> {
  const body = await get(adminListen, '/verdicts');
  if (!Array.isArray(body)) {
    throw new SidecarUnavailableError('/verdicts', 'the body was not a JSON array');
  }
  return body as SidecarVerdict[];
}

/**
 * `node:http` rather than `fetch`, for one reason: `socketPath`.
 *
 * The admin listener may be a unix socket, which is the stricter of the two
 * addresses the gatekeeper schema allows, and `fetch` has no way to name one.
 * Everything else about the call is as plain as it looks — local HTTP, one small
 * JSON document, a hard timeout.
 */
function get(adminListen: string, path: string): Promise<unknown> {
  const socketPath = adminListen.startsWith('unix:') ? adminListen.slice('unix:'.length) : undefined;
  const [host, port] = socketPath ? ['localhost', undefined] : splitHostPort(adminListen);

  return new Promise((resolve, reject) => {
    const fail = (reason: string) => reject(new SidecarUnavailableError(path, reason));
    const call = request({ socketPath, host, port, path, method: 'GET', timeout: REQUEST_TIMEOUT_MS }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        fail(`it answered ${response.statusCode}`);
        return;
      }
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          fail(`its body was not JSON (${error instanceof Error ? error.message : String(error)})`);
        }
      });
      response.on('error', (error: Error) => fail(error.message));
    });
    call.on('timeout', () => {
      // `timeout` only fires the event; the socket has to be closed explicitly,
      // or a hung sidecar would hold this promise open for ever.
      call.destroy(new Error(`it did not answer within ${REQUEST_TIMEOUT_MS} ms`));
    });
    call.on('error', (error: Error) => fail(error.message));
    call.end();
  });
}

function splitHostPort(listen: string): [string, number | undefined] {
  const separator = listen.lastIndexOf(':');
  if (separator < 0) {
    return [listen, undefined];
  }
  return [listen.slice(0, separator), Number(listen.slice(separator + 1)) || undefined];
}
