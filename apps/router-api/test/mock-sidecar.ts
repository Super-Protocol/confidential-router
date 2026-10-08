import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { COMPLETION_BODY, STREAM_CHUNKS, STREAM_USAGE } from './mock-litellm.js';

/**
 * The egress sidecar, as router-api sees it (ADR-008 §4/§5).
 *
 * From router-api's side the sidecar *is* the upstream: an OpenAI-compatible `/v1`
 * surface on a loopback port, plus a poll-only admin API that reports verdicts.
 * Everything beyond that — the pinned TLS handshake, the evidence fetch, the Rego
 * policy — happens on the far side of this seam and belongs to the gatekeeper's
 * own suite, not here.
 *
 * It answers with the same bodies `MockLiteLlm` does, deliberately: the property
 * the egress leg had to preserve is that everything above the seam behaves
 * identically, and asserting that is only meaningful when both legs are fed the
 * same bytes.
 */

export type SidecarBehaviour =
  /** A normal completion, streamed or not. */
  | 'serve'
  /** `writeDenial`: fail-closed 503 with the `gatekeeper_error` body. */
  | 'deny'
  /**
   * Two chunks, then the connection goes — which is what `applyVerdict` →
   * `closeAll` does to a stream in flight when a verdict is withdrawn.
   */
  | 'drop-mid-stream';

export interface RecordedUpstreamRequest {
  endpoint: string;
  path: string;
  body: Record<string, unknown>;
  authorization?: string;
  accept?: string;
  /** Every header, so a test can assert what was *not* sent. */
  headers: Record<string, string | string[] | undefined>;
}

/** One entry of the admin API's `/verdicts`, reduced to what router-api reads. */
export interface MockVerdict {
  endpoint: string;
  admitted: boolean;
  stage?: string;
  reason?: string;
  measurement?: string;
  evidenceDigest?: string;
}

export class MockEgressSidecar {
  readonly requests: RecordedUpstreamRequest[] = [];
  /** Per-endpoint data-plane behaviour, by endpoint name. */
  readonly behaviour = new Map<string, SidecarBehaviour>();
  /** What `/verdicts` reports, by endpoint name. */
  readonly verdicts = new Map<string, MockVerdict>();
  /** What the upstream's `GET /v1/models` lists, by endpoint name (SUP-249 discovery). */
  readonly modelLists = new Map<string, unknown[]>();
  /** A raw answer to `GET /v1/models` instead of a list — a refusal, or a body nobody should buffer. */
  readonly modelListAnswers = new Map<string, { status: number; body: string }>();

  private readonly listeners = new Map<string, Server>();
  private admin?: Server;

  /** Starts one loopback listener and returns the port to record on the row. */
  async listener(endpoint: string): Promise<number> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
        this.requests.push({
          endpoint,
          path: request.url ?? '',
          body,
          authorization: request.headers.authorization,
          accept: request.headers.accept,
          headers: request.headers,
        });
        if (request.method === 'GET' && request.url === '/v1/models') {
          this.listModels(endpoint, response);
          return;
        }
        this.respond(endpoint, body, response);
      });
    });
    this.listeners.set(endpoint, server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  /** Starts the admin API and returns an `externalEndpoints.adminListen` value. */
  async adminApi(): Promise<string> {
    const server = createServer((request, response) => {
      request.resume();
      if (request.url !== '/verdicts') {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          [...this.verdicts.values()].map((verdict) => ({
            endpoint: verdict.endpoint,
            health: verdict.admitted ? 'confidential' : 'broken',
            admitted: verdict.admitted,
            reason: verdict.reason,
            report: {
              checkedAt: new Date().toISOString(),
              verified: verdict.admitted,
              admitted: verdict.admitted,
              stage: verdict.stage,
              reason: verdict.reason,
              attestedRoot: verdict.measurement
                ? { measurement: verdict.measurement, measurementSource: 'operator-pinned', inRegistry: false }
                : undefined,
              observedTlsFingerprint: 'sha256/leaf',
              certFingerprint: 'sha256/leaf',
              evidenceDigest: verdict.evidenceDigest,
            },
          })),
        ),
      );
    });
    this.admin = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** Admits an endpoint, the way a successful re-attestation would. */
  admit(endpoint: string, options: { measurement?: string; evidenceDigest?: string } = {}): void {
    this.verdicts.set(endpoint, {
      endpoint,
      admitted: true,
      measurement: options.measurement ?? 'a'.repeat(64),
      evidenceDigest: options.evidenceDigest ?? 'sha256/upstream-bundle',
    });
    this.behaviour.set(endpoint, 'serve');
  }

  /** Withdraws the verdict, the way a trust-list edit or a failed re-check would. */
  withdraw(endpoint: string, reason = 'measurement is not on the trust list', stage = 'policy'): void {
    this.verdicts.set(endpoint, { endpoint, admitted: false, stage, reason });
    this.behaviour.set(endpoint, 'deny');
  }

  reset(): void {
    this.requests.length = 0;
  }

  async stop(): Promise<void> {
    const servers = [...this.listeners.values(), ...(this.admin ? [this.admin] : [])];
    this.listeners.clear();
    this.admin = undefined;
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }

  private listModels(endpoint: string, response: ServerResponse): void {
    if ((this.behaviour.get(endpoint) ?? 'serve') === 'deny') {
      this.respond(endpoint, {}, response);
      return;
    }
    const answer = this.modelListAnswers.get(endpoint);
    response.writeHead(answer?.status ?? 200, { 'content-type': 'application/json', 'x-gatekeeper-verdict': 'allow' });
    response.end(answer?.body ?? JSON.stringify({ object: 'list', data: this.modelLists.get(endpoint) ?? [] }));
  }

  private respond(endpoint: string, body: Record<string, unknown>, response: ServerResponse): void {
    const behaviour = this.behaviour.get(endpoint) ?? 'serve';
    if (behaviour === 'deny') {
      const verdict = this.verdicts.get(endpoint);
      const stage = verdict?.stage ?? 'policy';
      const reason = verdict?.reason ?? 'no valid verdict';
      response.writeHead(503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-gatekeeper-verdict': `deny ${stage}: ${reason}`,
      });
      response.end(
        JSON.stringify({
          error: { type: 'gatekeeper_error', code: 'attestation_failed', message: `${stage}: ${reason}` },
          stage,
          reason,
        }),
      );
      return;
    }

    if (body.stream === true) {
      this.stream(endpoint, body, response);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'x-gatekeeper-verdict': 'allow' });
    response.end(JSON.stringify(COMPLETION_BODY));
  }

  private stream(endpoint: string, body: Record<string, unknown>, response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-gatekeeper-verdict': 'allow',
    });

    const events = STREAM_CHUNKS.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
    if ((body.stream_options as { include_usage?: unknown } | undefined)?.include_usage) {
      events.push(
        `data: ${JSON.stringify({
          id: 'chatcmpl-upstream',
          object: 'chat.completion.chunk',
          created: 1_756_550_000,
          model: 'mock/chat',
          choices: [],
          usage: STREAM_USAGE,
        })}\n\n`,
      );
    }
    events.push('data: [DONE]\n\n');

    const dieAfter = this.behaviour.get(endpoint) === 'drop-mid-stream' ? 2 : Number.POSITIVE_INFINITY;
    let index = 0;
    const pump = (): void => {
      if (index >= dieAfter) {
        // The verdict is withdrawn and the connection it was carrying goes with
        // it, in that order — which is what fail-closed means for traffic already
        // in flight (ADR-003 §7).
        this.withdraw(endpoint);
        response.socket?.destroy();
        return;
      }
      if (index >= events.length) {
        response.end();
        return;
      }
      response.write(events[index]);
      index += 1;
      setTimeout(pump, 2);
    };
    pump();
  }
}
