/**
 * Runs the mock backend as a process.
 *
 *   node --experimental-strip-types tools/mock-litellm/src/main.ts
 *   PORT=4000 MOCK_CHUNK_GAP_MS=25 node tools/mock-litellm/src/main.ts
 *
 * The compose demo stack runs exactly this file (docker/demo/demo.dockerfile);
 * the e2e suites import `startMockLiteLLM` instead and never spawn a process.
 */
import { startMockLiteLLM } from './server.ts';

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';
const chunkGapMs = process.env.MOCK_CHUNK_GAP_MS ? Number(process.env.MOCK_CHUNK_GAP_MS) : undefined;

const backend = await startMockLiteLLM({ port, host, chunkGapMs });
console.log(`[mock-litellm] listening on ${backend.url} — OpenAI-compatible, answers every model`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void backend.close().then(() => process.exit(0));
  });
}
