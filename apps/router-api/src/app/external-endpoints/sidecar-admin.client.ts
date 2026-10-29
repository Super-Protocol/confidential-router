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

/**
 * Which trust factor a two-factor denial is about — `pkg/status` `Refusal*`, in the
 * order the core decides them (SUP-252).
 */
export type SidecarRefusal = 'digest-not-pinned' | 'measurement-not-trusted' | 'digest-mismatch';

/** One verification of one endpoint, as `/verdicts` carries it. */
export interface SidecarReport {
  checkedAt?: string;
  verified?: boolean;
  admitted?: boolean;
  /** ADR-003 §1 stage name of the failure; absent on success. */
  stage?: string;
  reason?: string;
  /**
   * Set only on a built-in denial of a `measurement-and-digest` endpoint: the
   * factor it refused on. Absent for a pipeline-stage failure, which is not a trust
   * answer about either factor.
   */
  refusal?: SidecarRefusal;
  /**
   * "We could not reach the upstream to run the check", as against "the check
   * failed" — the sidecar's own answer, and the only authoritative one
   * (`pkg/status/status.go`, SUP-422).
   *
   * Narrower than the `fetch` stage on purpose, and that is exactly why it must
   * be read rather than inferred: a dial, handshake or read failure sets it,
   * while a non-2xx answer to the bundle fetch, an over-sized bundle and a
   * hostname the gatekeeper refuses are all stage `fetch` with this unset
   * (`pkg/attestation/verify.go`). Those are an upstream answering badly, and
   * calling them unreachable would send an operator to look at a cloud that is
   * up.
   *
   * `omitempty` on the Go side, so absent means false on any report that carries
   * a stage at all.
   */
  unreachable?: boolean;
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
 *
 * `agent: false` — one socket per poll, and never a pooled one. This is the
 * whole of SUP-583 and it is not an optimisation; the default agent made this
 * client discard half the answers the sidecar gave it:
 *
 *  - `timeout` is a *socket* timeout, not a deadline on the call. It is armed
 *    with `socket.setTimeout(5000)` when the socket is assigned, and the
 *    default agent keeps the socket alive afterwards — so the timer goes into
 *    the agent's free pool still armed.
 *  - Five seconds after a poll returns, that idle socket emits `timeout`.
 *    `externalEndpoints.statusPollInterval` is five seconds, so the *next*
 *    poll has just claimed it and attached its own `timeout` listener. The
 *    listener fires milliseconds in, [get] destroys the request and reports
 *    "it did not answer within 5000 ms" — about a sidecar that answered.
 *  - The following poll finds the pool empty, opens a fresh socket and
 *    succeeds. Hence exactly every other poll, for ever.
 *
 * Production ran that way for days: 353 of the last 400 lines of the router's
 * log were this client blaming a healthy sidecar, every warning 10 s after the
 * last, each with a successful poll in between. A stand-in admin server logged
 * serving every request the client called unanswered, twice per socket.
 *
 * With no pool the five seconds bound a fresh connection to a process that
 * renders state already in memory, which is what the constant was written to
 * mean. The cost is one loopback connect per poll.
 */
function get(adminListen: string, path: string): Promise<unknown> {
  const socketPath = adminListen.startsWith('unix:') ? adminListen.slice('unix:'.length) : undefined;
  const [host, port] = socketPath ? ['localhost', undefined] : splitHostPort(adminListen);

  return new Promise((resolve, reject) => {
    const fail = (reason: string) => reject(new SidecarUnavailableError(path, reason));
    const call = request(
      { socketPath, host, port, path, method: 'GET', timeout: REQUEST_TIMEOUT_MS, agent: false },
      (response) => {
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
      },
    );
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
