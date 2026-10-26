import { describe, expect, it } from 'vitest';
import { describeUpstreamError, readUpstreamError, upstreamFailureOf } from './upstream-failure.js';

/**
 * The shared upstream error table (SUP-448).
 *
 * The row under test throughout is the last one: a 4xx the upstream raised about
 * the request body has to reach the client as a 4xx carrying the upstream's own
 * wording, because every alternative tells an OpenAI-compatible SDK to retry a
 * request that can never succeed.
 */

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, { status, headers: { 'content-type': 'application/json', ...headers } });
}

async function mapped(status: number, body: unknown, headers: Record<string, string> = {}) {
  const upstream = answer(status, body, headers);
  return upstreamFailureOf('The model backend', upstream, await readUpstreamError(upstream));
}

describe('readUpstreamError', () => {
  it('reads OpenAI’s nested shape', async () => {
    const body = await readUpstreamError(answer(400, { error: { message: 'bad arguments', param: 'messages' } }));

    expect(body).toMatchObject({ text: 'bad arguments', param: 'messages' });
  });

  it('reads vLLM’s flat shape, which is what the production endpoint answers with', async () => {
    // `qwen3-coder-next` on a bad request: no `error` wrapper at all. Missing it
    // is how the reason stopped reaching the client in the first place.
    const body = await readUpstreamError(
      answer(400, { object: 'error', message: 'tool_calls[0].function.arguments is not valid JSON', code: 400 }),
    );

    expect(body.text).toBe('tool_calls[0].function.arguments is not valid JSON');
  });

  it('keeps a non-JSON body as its own text, and marks it unstructured', async () => {
    const body = await readUpstreamError(new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    expect(body).toMatchObject({ text: '<html>502 Bad Gateway</html>', structured: false, parsed: null });
  });

  it('marks a JSON body with no message of its own unstructured too', async () => {
    // FastAPI's validation dump: valid JSON, no `message` anywhere, and nothing
    // in it a client could read as a sentence.
    const body = await readUpstreamError(answer(422, { detail: [{ loc: ['body', 'messages'], type: 'list_type' }] }));

    expect(body.structured).toBe(false);
  });

  it('marks a message the upstream actually wrote as structured', async () => {
    expect((await readUpstreamError(answer(400, { error: { message: 'bad arguments' } }))).structured).toBe(true);
    expect((await readUpstreamError(answer(400, { message: 'bad arguments' }))).structured).toBe(true);
  });

  it('survives a body it cannot read at all', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error('connection reset while reading the error body'));
      },
    });

    expect(await readUpstreamError(new Response(stream, { status: 400 }))).toEqual({
      text: '',
      structured: false,
      length: 0,
      parsed: null,
    });
  });

  it('ignores a param that is not a non-empty string', async () => {
    expect(await readUpstreamError(answer(400, { message: 'nope', param: null }))).not.toHaveProperty('param');
  });

  it('reports the body’s full length, not the truncated one', async () => {
    const body = await readUpstreamError(new Response('x'.repeat(4096), { status: 400 }));

    expect(body.length).toBe(4096);
    expect(body.text).toHaveLength(1000);
  });
});

/**
 * The log half of SUP-497. `/privacy` §5 says prompt text is never written to a
 * log, and a model server's 4xx is where it quotes the request back — so these
 * assert what the line does *not* carry, which is the only form the claim has.
 */
describe('describeUpstreamError', () => {
  it('keeps the error class and the field, and drops the wording', async () => {
    const body = await readUpstreamError(
      answer(400, {
        error: {
          message: 'messages[2].content: "my production database password is hunter2" is not valid',
          param: 'messages[2].content',
          type: 'invalid_request_error',
        },
      }),
    );

    const line = describeUpstreamError(body);

    expect(line).toContain('type=invalid_request_error');
    expect(line).toContain('param=messages[2].content');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain(body.text);
  });

  it('drops an unstructured body entirely, naming only its size', async () => {
    const quoted = 'Bad Request: rejected prompt "write me a poem about hunter2"';
    const body = await readUpstreamError(new Response(quoted, { status: 400 }));

    expect(describeUpstreamError(body)).toBe(`${quoted.length} chars, unstructured (not logged)`);
  });

  it('separates an upstream that said nothing from one that wrote a page', async () => {
    expect(describeUpstreamError(await readUpstreamError(new Response('', { status: 502 })))).toBe('no body');
    expect(describeUpstreamError(await readUpstreamError(new Response('<html>…</html>', { status: 502 })))).toContain(
      '14 chars',
    );
  });

  it('drops a `param` that is prose rather than a field path', async () => {
    // The hole the field name would otherwise leave open: an upstream is free to
    // put anything in `param`, and one that echoes the rejected value there
    // would put it straight into the log.
    const body = await readUpstreamError(
      answer(400, { error: { message: 'no', param: 'the prompt "write me a poem about hunter2"', type: 'bad_req' } }),
    );

    const line = describeUpstreamError(body);

    expect(line).toContain('type=bad_req');
    expect(line).not.toContain('param=');
    expect(line).not.toContain('hunter2');
  });

  it('never returns the body text, under any shape an upstream answers with', async () => {
    const secret = 'the prompt I typed, verbatim';
    const shapes: unknown[] = [
      { error: { message: secret, param: secret, type: secret } },
      { object: 'error', message: secret, code: 400 },
      { detail: [{ loc: ['body', 'messages'], msg: secret }] },
      secret,
    ];

    for (const shape of shapes) {
      const body = await readUpstreamError(answer(400, shape));

      expect(describeUpstreamError(body)).not.toContain(secret);
    }
  });
});

describe('a 4xx about the request body', () => {
  it('reaches the client as that 4xx, not as a 502', async () => {
    const error = await mapped(400, {
      object: 'error',
      message: 'Invalid JSON in messages[8].tool_calls[0].function.arguments.',
    });

    expect(error.status).toBe(400);
    expect(error.type).toBe('invalid_request_error');
    expect(error.code).toBe('upstream_invalid_request');
  });

  it('carries the upstream’s wording, which is the only thing naming the bad field', async () => {
    const error = await mapped(400, {
      error: {
        message: 'Invalid JSON in messages[8].tool_calls[0].function.arguments.',
        param: 'messages[8].tool_calls[0].function.arguments',
      },
    });

    expect(error.message).toContain('messages[8].tool_calls[0].function.arguments');
    expect(error.param).toBe('messages[8].tool_calls[0].function.arguments');
    expect(error.toBody().error.param).toBe('messages[8].tool_calls[0].function.arguments');
  });

  it('names the upstream status even when it answered 422', async () => {
    const error = await mapped(422, { error: { message: 'messages must not be empty' } });

    expect(error.status).toBe(422);
    expect(error.message).toContain('(422)');
  });

  it('says so when the upstream gave no reason at all', async () => {
    const error = await mapped(400, '');

    expect(error.status).toBe(400);
    expect(error.message).toContain('Retrying it unchanged will fail the same way.');
  });

  it('does not hand the caller an intermediary’s error page as the reason', async () => {
    // An nginx/Envoy 400 in front of the model server. The status is still honest
    // — the request is not getting through as sent — but the page says nothing
    // about the request, and neither leg ever forwarded one.
    const page = '<html><head><title>400 Bad Request</title></head><body><center>nginx/1.27.0</center></body></html>';

    const error = await mapped(400, page);

    expect(error.status).toBe(400);
    expect(error.code).toBe('upstream_invalid_request');
    expect(error.message).not.toContain('nginx');
    expect(error.message).not.toContain('<html>');
    expect(error.message).toContain('Retrying it unchanged will fail the same way.');
  });

  it('does not hand the caller a validation dump it cannot read either', async () => {
    const error = await mapped(422, { detail: [{ loc: ['body', 'messages', 8], type: 'list_type' }] });

    expect(error.status).toBe(422);
    expect(error.code).toBe('upstream_invalid_request');
    expect(error.message).not.toContain('list_type');
    expect(error.message).toContain('Retrying it unchanged will fail the same way.');
  });

  it('collapses a status an SDK would retry to 400, so the loop cannot restart', async () => {
    // 408/409/425 are auto-retried by OpenAI-compatible SDKs. Forwarding them
    // verbatim would reproduce exactly the death spiral SUP-448 is about.
    for (const status of [408, 409, 425]) {
      const error = await mapped(status, { error: { message: 'no' } });

      expect(error.status).toBe(400);
      expect(error.message).toContain(`(${status})`);
    }
  });
});

describe('a failure that is not the caller’s', () => {
  it('keeps our own refused credential a 502, never the caller’s 401', async () => {
    for (const status of [401, 402, 403, 407]) {
      const error = await mapped(status, { error: { message: 'Invalid LiteLLM key.' } });

      expect(error.status).toBe(502);
      expect(error.code).toBe('backend_error');
      expect(error.message).not.toContain('Invalid LiteLLM key');
    }
  });

  it('keeps a 5xx and a 404 as backend_unavailable', async () => {
    for (const status of [404, 500, 502, 503]) {
      const error = await mapped(status, { error: { message: 'the worker crashed' } });

      expect(error.status).toBe(502);
      expect(error.code).toBe('backend_unavailable');
    }
  });

  it('passes a capacity refusal through with its Retry-After', async () => {
    const error = await mapped(429, { error: { message: 'all workers busy' } }, { 'retry-after': '7' });

    expect(error.status).toBe(429);
    expect(error.code).toBe('rate_limit_exceeded');
    expect(error.headers['Retry-After']).toBe('7');
    expect(error.message).toBe('The model backend is at capacity.');
  });

  it('still reads a context-length message as the code a client branches on', async () => {
    const error = await mapped(400, {
      error: { message: "This model's maximum context length is 4096 tokens, however you requested 9000." },
    });

    expect(error.code).toBe('context_length_exceeded');
    expect(error.param).toBe('messages');
  });

  it('refuses to relay a status that is not a response at all', async () => {
    const error = await mapped(302, '');

    expect(error.status).toBe(502);
    expect(error.code).toBe('backend_error');
  });
});

describe('the upstream’s name', () => {
  it('is the one belonging to the leg that asked', async () => {
    const upstream = answer(400, { error: { message: 'nope' } });

    const error = upstreamFailureOf('The external model endpoint', upstream, await readUpstreamError(upstream));

    expect(error.message).toMatch(/^The external model endpoint rejected this request as invalid/);
  });
});
