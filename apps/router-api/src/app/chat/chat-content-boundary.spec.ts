import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinoHttpConfig } from '@confidential-router/server-common';
import { CONSOLE_INGEST_EVENTS } from '@confidential-router/types';
import { describe, expect, it, vi } from 'vitest';

/**
 * The console chat's own invariant, on the paths content must never reach.
 *
 * `chat_messages.content` is the one place in this service that holds what a
 * user typed and a model answered (ADR-007 §4; the entity-shape half of this is
 * in `db/entities/invariants.spec.ts`). An exception is only as good as its
 * edges, so these are the four edges the issue named — logs, analytics events,
 * the evidence snapshot, and any export — asserted structurally rather than left
 * to reviewer memory.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');

function source(relativePath: string): string {
  return readFileSync(join(APP, relativePath), 'utf8');
}

describe('chat content and the analytics taxonomy', () => {
  it('has no console event that could carry a transcript', () => {
    // The taxonomy is a closed list router-api validates against before
    // forwarding (ADR-006 §3). No chat event exists, which is the strongest form
    // of "chat content never reaches analytics": there is nothing to put it in.
    const chatty = CONSOLE_INGEST_EVENTS.filter((event) => /chat|message|prompt|thread/i.test(event));

    expect(chatty).toEqual([]);
  });

  it('is written by code that cannot reach the analytics service', () => {
    // Not a grep for a bad call — a check that the dependency is absent, so the
    // call cannot be added without also adding the import a reviewer would see.
    const service = source('chat/chat.service.ts');
    const resolver = source('api/graphql/chat/chat.resolver.ts');

    expect(service).not.toMatch(/AnalyticsService|analytics/i);
    expect(resolver).not.toMatch(/AnalyticsService/);
  });
});

describe('chat content and the logs', () => {
  it('is never logged, because the request logger records metadata and no bodies', () => {
    // A transcript reaches this service as a GraphQL mutation variable. pino-http
    // serialises the request line, headers and status — never the body — so the
    // content has no path into a log record. If a future change adds a `req`
    // serializer that includes one, this fails.
    const options = createPinoHttpConfig({ level: 'info' }) as Record<string, unknown>;

    expect(options.serializers).toBeUndefined();
    expect(JSON.stringify(options)).not.toMatch(/body/i);
  });

  it('is not logged by the chat code itself', () => {
    // The service stores content; it must not also narrate it. No logger at all
    // is the cheapest way to be sure.
    expect(source('chat/chat.service.ts')).not.toMatch(/\bLogger\b|console\.(log|info|warn|error)/);
  });
});

describe('chat content and the evidence export', () => {
  it('is never read by the export, which touches three repositories and no chat table', () => {
    /*
     * The export is the one feature that walks the database and hands the result
     * to a user as a file, so it is the likeliest accident. Rather than trust the
     * current source, this records which repositories it opens: `Generation`,
     * `EvidenceSnapshot` and `Endpoint`, and nothing else.
     */
    const exportSource = source('preferences/evidence-export.service.ts');

    const repositories = [...exportSource.matchAll(/getRepository\(\s*(\w+)\s*\)/g)].map((match) => match[1]);

    expect([...new Set(repositories)].sort()).toEqual(['Endpoint', 'EvidenceSnapshot', 'Generation']);
    expect(exportSource).not.toMatch(/ChatThread|ChatMessage|chat_/);
  });
});

describe('chat content and the evidence snapshot', () => {
  it('cannot appear in a bundle, because the parser only ever reads what an endpoint published', () => {
    // `parseEvidenceBundle` takes the fetched document and the hostname; it has
    // no database handle and no chat import, so a snapshot cannot acquire a
    // transcript however the bundle shape changes.
    const bundle = source('evidence/evidence-bundle.ts');

    expect(bundle).not.toMatch(/ChatThread|ChatMessage|chat/i);
    expect(bundle).not.toMatch(/getRepository|DataSource/);
  });
});

describe('what the chat service will refuse', () => {
  it('reads its message ceiling from config rather than trusting the caller', async () => {
    // The cap is published to the browser so the composer can show a counter,
    // and enforced here so a client that ignores it is refused. Both halves
    // matter: the first is courtesy, the second is why a demo surface cannot
    // become free storage.
    const { ChatService } = await import('./chat.service.js');
    const service = new ChatService(
      { chat: { maxMessageChars: 10, maxThreads: 5, maxMessagesPerThread: 4 } } as never,
      { getRepository: vi.fn() } as never,
    );

    await expect(
      service.appendMessage({
        workspaceId: 'ws-1',
        userId: 'user-1',
        threadId: 't-1',
        role: 'user',
        content: 'x'.repeat(11),
      }),
    ).rejects.toThrow(/at most 10 characters/);
  });
});
