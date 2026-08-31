/**
 * A LiteLLM-compatible backend for the compose demo stack.
 *
 * `apps/router-api/test/mock-litellm.ts` is the same idea for the e2e suite: it
 * runs in-process and selects a *failure* by the model the router forwards,
 * because a test needs the error table. This one only has to make the demo
 * produce real generations — a request that arrives here comes back as a
 * metered answer with plausible token counts, whatever model was asked for.
 *
 * No dependencies on purpose: it must run from a bare `node:alpine` layer.
 *
 *   PORT=4000 node mock-litellm.mjs
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';
/** Gap between streamed chunks. Slow enough that the console shows a real tokens/s. */
const CHUNK_GAP_MS = Number(process.env.MOCK_CHUNK_GAP_MS ?? 25);

/**
 * Tokens are counted the way every mock counts them — four characters each. The
 * demo needs the meter to move and the numbers to look sane, not to agree with
 * a real tokenizer.
 */
const charsPerToken = 4;
const tokensOf = (text) => Math.max(1, Math.ceil(text.length / charsPerToken));

const REPLY_SENTENCES = [
  'This answer came from a mock model in the compose demo stack, not from a TEE.',
  'The router in front of it is real: it authenticated your key, priced the request and metered it.',
  'Swap `backends.litellm.baseUrl` for a real LiteLLM and nothing else about the flow changes.',
];

function replyFor(body) {
  const prompt = promptTextOf(body);
  const opening = prompt ? `You said: ${prompt.slice(0, 200)}` : 'Hello.';
  return [opening, ...REPLY_SENTENCES].join(' ');
}

function promptTextOf(body) {
  if (typeof body.prompt === 'string') {
    return body.prompt;
  }
  if (!Array.isArray(body.messages)) {
    return '';
  }
  const last = [...body.messages].reverse().find((message) => message?.role === 'user');
  const content = last?.content;
  if (typeof content === 'string') {
    return content;
  }
  // The OpenAI content-parts form: [{ type: 'text', text: '…' }, …].
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join(' ')
      .trim();
  }
  return '';
}

function usageFor(body, completion) {
  const promptTokens = tokensOf(JSON.stringify(body.messages ?? body.prompt ?? ''));
  const completionTokens = tokensOf(completion);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

function completion(model, body) {
  const content = replyFor(body);
  return {
    id: `chatcmpl-mock-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: usageFor(body, content),
  };
}

function textCompletion(model, body) {
  const text = replyFor(body);
  return {
    id: `cmpl-mock-${Date.now().toString(36)}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, text, finish_reason: 'stop', logprobs: null }],
    usage: usageFor(body, text),
  };
}

/**
 * The router always forwards `stream_options.include_usage: true` so its meter
 * is exact rather than estimated, and then strips the extra chunk again if the
 * client did not ask for it. Honouring the flag is therefore not optional here.
 */
function stream(model, body, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const id = `chatcmpl-mock-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const content = replyFor(body);
  const chunk = (choices, extra = {}) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`;

  // Word by word, keeping the leading space so concatenating the deltas
  // reproduces the text exactly.
  const words = content.match(/\s*\S+/g) ?? [content];
  const events = [
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
    ...words.map((word) => chunk([{ index: 0, delta: { content: word }, finish_reason: null }])),
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
  ];
  if (body.stream_options?.include_usage) {
    // A usage-only chunk: `choices` present and empty, as OpenAI defines it.
    events.push(chunk([], { usage: usageFor(body, content) }));
  }
  events.push('data: [DONE]\n\n');

  let index = 0;
  const pump = () => {
    if (response.writableEnded || response.destroyed) {
      return;
    }
    if (index >= events.length) {
      response.end();
      return;
    }
    response.write(events[index]);
    index += 1;
    setTimeout(pump, CHUNK_GAP_MS);
  };
  pump();
}

function handle(path, body, response) {
  const model = String(body.model ?? 'mock/chat');

  if (path.endsWith('/chat/completions')) {
    if (body.stream === true) {
      stream(model, body, response);
      return;
    }
    json(response, 200, completion(model, body));
    return;
  }
  if (path.endsWith('/completions')) {
    json(response, 200, textCompletion(model, body));
    return;
  }
  if (path.endsWith('/embeddings')) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
    json(response, 200, {
      object: 'list',
      model,
      data: inputs.map((_, index) => ({
        object: 'embedding',
        index,
        // Deterministic and short; a demo never compares these to anything.
        embedding: Array.from({ length: 8 }, (_, position) => Number(((index + position) / 16).toFixed(4))),
      })),
      usage: usageFor(body, ''),
    });
    return;
  }
  json(response, 404, { error: { message: `mock-litellm does not serve ${path}`, type: 'invalid_request_error' } });
}

const server = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];

  if (request.method === 'GET') {
    if (path === '/health' || path === '/health/liveliness') {
      json(response, 200, { status: 'ok' });
      return;
    }
    // The router serves /v1/models from its own catalogue and never asks here,
    // but a curl against the backend should not 404.
    if (path === '/v1/models' || path === '/models') {
      json(response, 200, { object: 'list', data: [] });
      return;
    }
    json(response, 404, { error: { message: `mock-litellm does not serve ${path}` } });
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      json(response, 400, { error: { message: 'body is not JSON', type: 'invalid_request_error' } });
      return;
    }
    handle(path, body, response);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-litellm] listening on http://${HOST}:${PORT} — OpenAI-compatible, answers every model`);
});
