import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigType } from '@nestjs/config';
import { afterEach, describe, expect, it } from 'vitest';
import type { routerConfig } from '../../config.js';
import type { SecretEnvelopeService } from '../../secrets/index.js';
import { ExternalUpstreamClient } from './external-upstream.client.js';
import type { ExternalRoute, RoutedModel } from './gateway.types.js';
import { OpenAiApiError } from './openai-error.js';

/**
 * The egress leg against stand-in sidecars on loopback — one for the data plane
 * and one for the admin API, which is exactly how the two are reached in the pod.
 */

const servers: Server[] = [];

async function serving(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function clientFor(options: { listenPort?: number; adminListen?: string } = {}): ExternalUpstreamClient {
  const config = {
    externalEndpoints: {
      adminListen: options.adminListen ?? '127.0.0.1:1',
      connectTimeout: 2_000,
      readTimeout: 5_000,
    },
  } as ConfigType<typeof routerConfig>;
  // Opening the envelope is `secret-envelope.spec.ts`'s subject; what matters here
  // is that this leg opens it and puts the result in `Authorization`, and nowhere
  // else.
  const secrets = { open: (ciphertext: string) => `plain-of-${ciphertext}` } as unknown as SecretEnvelopeService;
  return new ExternalUpstreamClient(config, secrets);
}

function model(listenPort: number, overrides: Partial<ExternalRoute> = {}): RoutedModel & { external: ExternalRoute } {
  const external: ExternalRoute = {
    baseUrl: `http://127.0.0.1:${listenPort}`,
    apiKeyCiphertext: 'v1.sealed',
    evidenceDigestSeen: 'sha256/upstream',
    measurementSeen: null,
    ...overrides,
  };
  return {
    id: 'partner/chat:snp',
    name: 'Partner chat',
    upstreamModel: 'partner-chat',
    contextLength: 8192,
    capabilities: ['chat'],
    promptPer1mMicros: 1,
    completionPer1mMicros: 1,
    origin: 'external',
    endpoint: { id: 'xep-1', name: 'partner-cloud', hostname: 'api.partner.example', tee: 'AMD SEV-SNP' },
    external,
    updatedAt: new Date('2026-10-06T00:00:00Z'),
  };
}

/** The sidecar's own fail-closed 503 (`writeDenial`, `pkg/proxy/handler.go`). */
const GATEKEEPER_DENIAL = {
  error: { type: 'gatekeeper_error', code: 'attestation_failed', message: 'policy: measurement not trusted' },
  stage: 'policy',
  reason: 'measurement not trusted',
};

describe('send', () => {
  it('posts to the loopback listener and injects the opened upstream key', async () => {
    let seen: { url?: string; authorization?: string; accept?: string; body?: unknown } = {};
    const port = await serving((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen = {
          url: request.url,
          authorization: request.headers.authorization,
          accept: request.headers.accept,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });

    const response = await clientFor().send({
      model: model(port),
      path: '/v1/chat/completions',
      body: { model: 'partner-chat', messages: [] },
      stream: false,
      signal: AbortSignal.timeout(5_000),
    });

    expect(response.status).toBe(200);
    expect(seen.url).toBe('/v1/chat/completions');
    expect(seen.authorization).toBe('Bearer plain-of-v1.sealed');
    expect(seen.accept).toBe('application/json');
  });

  it('asks for an event stream when the client streams', async () => {
    let accept: string | undefined;
    const port = await serving((request, response) => {
      accept = request.headers.accept;
      request.resume();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end();
    });

    await clientFor().send({
      model: model(port),
      path: '/v1/chat/completions',
      body: {},
      stream: true,
      signal: AbortSignal.timeout(5_000),
    });

    expect(accept).toBe('text/event-stream');
  });

  it('sends no generation-correlation header: another operator’s logs are not ours', async () => {
    let headers: Record<string, string | string[] | undefined> = {};
    const port = await serving((request, response) => {
      headers = request.headers;
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });

    await clientFor().send({
      model: model(port),
      path: '/v1/chat/completions',
      body: {},
      stream: false,
      signal: AbortSignal.timeout(5_000),
    });

    expect(headers['x-litellm-metadata']).toBeUndefined();
    expect(Object.keys(headers).filter((name) => name.startsWith('x-confidential-router'))).toEqual([]);
  });
});

describe('the stored upstream key', () => {
  it('fails as the router’s own fault when the envelope cannot be opened', async () => {
    // `CR_API_SECRETS_KEY` unset, malformed, or rotated since the row was written.
    // The caller did nothing wrong and must not be told what this deployment's
    // secret configuration looks like.
    const config = {
      externalEndpoints: { adminListen: '127.0.0.1:9465', connectTimeout: 2_000, readTimeout: 5_000 },
    } as ConfigType<typeof routerConfig>;
    const secrets = {
      open: () => {
        throw new Error('CR_API_SECRETS_KEY is not a usable AES-256 key: it decodes to 8 bytes.');
      },
    } as unknown as SecretEnvelopeService;
    let dialled = false;
    const port = await serving((request, response) => {
      dialled = true;
      request.resume();
      response.end('{}');
    });

    const failure = await new ExternalUpstreamClient(config, secrets)
      .send({
        model: model(port),
        path: '/v1/chat/completions',
        body: {},
        stream: false,
        signal: AbortSignal.timeout(5_000),
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OpenAiApiError);
    expect(failure).toMatchObject({ status: 500, code: 'internal' });
    expect((failure as OpenAiApiError).message).not.toContain('CR_API_SECRETS_KEY');
    // And nothing left for the sidecar: a request with no credential would only
    // make the upstream refuse it.
    expect(dialled).toBe(false);
  });
});

describe('mapFailure', () => {
  it('turns the sidecar’s fail-closed 503 into 503 attestation_failed, naming the stage', async () => {
    const error = await clientFor().mapFailure(model(1), jsonResponse(503, GATEKEEPER_DENIAL));

    expect(error.status).toBe(503);
    expect(error.type).toBe('gatekeeper_error');
    expect(error.code).toBe('attestation_failed');
    expect(error.message).toContain('policy: measurement not trusted');
    expect(error.message).toContain('Nothing was sent to it.');
    expect(error.headers['Cache-Control']).toBe('no-store');
  });

  it('defaults the stage and reason when the sidecar names neither', async () => {
    const error = await clientFor().mapFailure(model(1), jsonResponse(503, { error: { type: 'gatekeeper_error' } }));

    expect(error.code).toBe('attestation_failed');
    expect(error.message).toContain('policy: no valid verdict');
  });

  it('does not read an upstream’s own 503 as an attestation failure', async () => {
    // Only the sidecar writes `gatekeeper_error`. A model server answering 503
    // because it is restarting is `backend_unavailable`, and a client should
    // retry it.
    const error = await clientFor().mapFailure(model(1), jsonResponse(503, { error: { message: 'restarting' } }));

    expect(error.status).toBe(502);
    expect(error.code).toBe('backend_unavailable');
  });

  it('passes a capacity refusal through with its Retry-After', async () => {
    const response = jsonResponse(429, { error: { message: 'busy' } }, { 'retry-after': '7' });

    const error = await clientFor().mapFailure(model(1), response);

    expect(error.status).toBe(429);
    expect(error.headers['Retry-After']).toBe('7');
  });

  it('forwards the one upstream message a caller can act on', async () => {
    const response = jsonResponse(400, {
      error: { message: "This model's maximum context length is 8192 tokens, however you requested 9000." },
    });

    const error = await clientFor().mapFailure(model(1), response);

    expect(error.code).toBe('context_length_exceeded');
  });
});

describe('classifyStreamFailure', () => {
  it('reports a withdrawn verdict as an abort named attestation_revoked', async () => {
    // The connection died because `applyVerdict` closed it under fail-closed.
    // Denis's ruling 5: metered `aborted`, and the client sees policy.
    const adminPort = await serving((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify([
          {
            endpoint: 'partner-cloud',
            health: 'broken',
            admitted: false,
            reason: 'measurement not trusted',
            report: { stage: 'policy', reason: 'measurement not trusted' },
          },
        ]),
      );
    });

    const failure = await clientFor({ adminListen: `127.0.0.1:${adminPort}` }).classifyStreamFailure(
      model(1),
      new Error('socket hang up'),
    );

    expect(failure.status).toBe('aborted');
    expect(failure.error.code).toBe('attestation_revoked');
    expect(failure.error.status).toBe(503);
    expect(failure.error.message).toContain('policy: measurement not trusted');
    expect(failure.error.message).toContain('Tokens already delivered are metered.');
  });

  it('reports an upstream failure when the verdict still stands', async () => {
    const adminPort = await serving((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ endpoint: 'partner-cloud', health: 'confidential', admitted: true }]));
    });

    const failure = await clientFor({ adminListen: `127.0.0.1:${adminPort}` }).classifyStreamFailure(
      model(1),
      new Error('socket hang up'),
    );

    expect(failure.status).toBe('error');
    expect(failure.error.code).toBe('backend_unavailable');
  });

  it('does not invent a revocation when the sidecar cannot be reached', async () => {
    // The stream is dead either way, so nothing is admitted by guessing — and
    // naming a policy decision that may never have happened is the same lie in
    // the other direction.
    const failure = await clientFor({ adminListen: '127.0.0.1:1' }).classifyStreamFailure(
      model(1),
      new Error('socket hang up'),
    );

    expect(failure.status).toBe('error');
    expect(failure.error.code).toBe('backend_unavailable');
  });

  it('does not report a revocation for an endpoint the sidecar never mentions', async () => {
    const adminPort = await serving((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('[]');
    });

    const failure = await clientFor({ adminListen: `127.0.0.1:${adminPort}` }).classifyStreamFailure(
      model(1),
      new Error('socket hang up'),
    );

    expect(failure.status).toBe('error');
  });
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
