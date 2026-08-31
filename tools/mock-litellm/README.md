# mock-litellm

A minimal OpenAI-compatible server standing in for LiteLLM.

The router forwards every `/v1` request to `backends.litellm.baseUrl`
(ADR-002 §9). Nothing in this repository's tests, demos or CI has a real LiteLLM
to forward to, so this is what sits there instead.

It is a *stand-in*, not a simulator. The text it returns is canned and the token
counts are four-characters-per-token arithmetic. What has to be right is the
wire shape, because that is the contract the router is written against:

- `POST /v1/chat/completions`, streamed and not
- `POST /v1/completions`, `POST /v1/embeddings`
- a `usage` block on every non-streamed response, and a usage-only chunk when
  `stream_options.include_usage` asks for one — the router always asks, so its
  meter is exact rather than estimated
- `GET /health`, `GET /v1/models`

## Using it

In process, which is how every suite uses it:

```ts
import { startMockLiteLLM } from '@confidential-router/mock-litellm';

const backend = await startMockLiteLLM({
  // Port 0 (the default) binds an ephemeral port; read it back from `url`.
  failures: { 'vllm/broken': { status: 502, message: 'the model is down' } },
});

// … point the router at backend.url …

backend.requests;   // every request the router forwarded, in order
await backend.close();
```

`failures` is keyed by the model the *router forwards*, not the one the client
named, so a test can drive the router's upstream-error table without a second
server. `requests` is what proves the router forwarded the catalogue's
`litellmModel` and did not leak the workspace's credential upstream.

As a process:

```bash
PORT=4000 node tools/mock-litellm/src/main.ts
```

Node runs the TypeScript sources directly (type stripping, on by default since
Node 23.6). There are no dependencies and there is no build step for this path —
which is why `docker/demo/demo.dockerfile` copies `src/` and runs it from a bare
`node:alpine` layer rather than keeping a second copy of this server next to the
compose file.

## Why the imports say `.ts`

`main.ts` imports `./server.ts`, not `./server.js`. That is what makes the file
runnable by bare `node`, and TypeScript rewrites it to `.js` on the way out
(`rewriteRelativeImportExtensions`). This project is the exception in the
workspace, for that one reason.

## Tests

```bash
pnpm nx run @confidential-router/mock-litellm:test
```

They pin the wire shape — the usage block, the delta stream concatenating back
to the completion, the usage-only chunk appearing only when asked for — because
a mock that quietly drifts from the shape it stands in for makes every suite
above it meaningless.
