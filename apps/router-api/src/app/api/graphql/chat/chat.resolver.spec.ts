import { ForbiddenException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyService } from '../../../api-keys/api-key.service.js';
import type { SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import type { CatalogModel, CatalogService } from '../../../catalog/catalog.service.js';
import type { ChatService } from '../../../chat/index.js';
import type { routerConfig } from '../../../config.js';
import type { ApiKey } from '../../../db/entities/api-key.entity.js';
import { CHAT_KEY_NAME, ChatResolver } from './chat.resolver.js';

type RouterConfig = ConfigType<typeof routerConfig>;

const USER = { id: 'user-1', email: 'dev@example.test' } as SessionUser;

const CHAT_DEFAULTS = {
  enabled: true,
  maxMessageChars: 8_000,
  maxThreads: 50,
  maxMessagesPerThread: 200,
  credentialTtl: 7_200_000,
};

function model(id: string, capabilities: CatalogModel['capabilities']): CatalogModel {
  return {
    id,
    name: id,
    litellmModel: id,
    contextLength: 8_192,
    capabilities,
    promptPer1mMicros: 1,
    completionPer1mMicros: 1,
    endpoint: { id: 'ep-1', name: 'router', hostname: 'router.test', tee: 'tdx' },
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  };
}

interface Harness {
  resolver: ChatResolver;
  create: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
  listLiveByPurpose: ReturnType<typeof vi.fn>;
  live: ApiKey[];
}

function build(
  options: { chat?: Partial<typeof CHAT_DEFAULTS>; models?: CatalogModel[]; live?: ApiKey[] } = {},
): Harness {
  const live = options.live ?? [];
  const create = vi.fn(async (input: { expiresAt?: Date | null }) => ({
    key: { id: 'key-1', expiresAt: input.expiresAt ?? null } as ApiKey,
    secret: 'sk-tee-v1-secret',
  }));
  const revoke = vi.fn(async (key: ApiKey) => key);
  const listLiveByPurpose = vi.fn(async () => live);

  const config = {
    chat: { ...CHAT_DEFAULTS, ...options.chat },
    server: { publicBaseUrl: 'https://api.router.test/' },
  } as unknown as RouterConfig;

  const resolver = new ChatResolver(
    config,
    { create, revoke, listLiveByPurpose } as unknown as ApiKeyService,
    { requireMembership: vi.fn(async () => ({ id: 'ws-1' })) } as unknown as WorkspaceScopeService,
    {
      list: () => options.models ?? [model('meta/llama-3.2-3b', ['chat', 'completions'])],
    } as unknown as CatalogService,
    // The transcript store. `chatSettings` and `chatCredential` never touch it;
    // the operations that do are tested in `app/chat/chat.service.spec.ts`.
    {} as unknown as ChatService,
  );

  return { resolver, create, revoke, listLiveByPurpose, live };
}

describe('chatSettings', () => {
  it('publishes the configured limits', () => {
    const settings = build({ chat: { maxMessageChars: 42, maxThreads: 3 } }).resolver.chatSettings();

    expect(settings).toMatchObject({ enabled: true, maxMessageChars: 42, maxThreads: 3, maxMessagesPerThread: 200 });
  });

  it('says the history lives on the server, because that is now where it lives', () => {
    // The console derives its own privacy copy from this field. It reads
    // `attested_server` since Denis unblocked server-side history — which licenses
    // "inside the attested boundary, encrypted at rest" and emphatically not
    // "durable": the state disk is ephemeral by design, and every surface that
    // mentions storage says so in the same breath.
    expect(build().resolver.chatSettings().historyStorage).toBe('attested_server');
  });

  it('offers only chat-capable models', () => {
    const settings = build({
      models: [
        model('vendor/embed', ['embeddings']),
        model('vendor/chatty', ['chat']),
        model('vendor/legacy', ['completions']),
      ],
    }).resolver.chatSettings();

    expect(settings.chatModelIds).toEqual(['vendor/chatty']);
  });
});

describe('chatCredential', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T12:00:00.000Z'));
  });

  it('mints a key scoped to the chat-capable catalogue, on the public /v1 base URL', async () => {
    const harness = build();

    const credential = await harness.resolver.chatCredential(USER, { workspaceId: 'ws-1' });

    expect(credential).toEqual({
      apiKeyId: 'key-1',
      secret: 'sk-tee-v1-secret',
      expiresAt: new Date('2026-09-30T14:00:00.000Z'),
      baseUrl: 'https://api.router.test/v1',
      modelScope: ['meta/llama-3.2-3b'],
    });
    expect(harness.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: CHAT_KEY_NAME, purpose: 'console_chat', modelScope: ['meta/llama-3.2-3b'] }),
    );
  });

  it('revokes the chat key it replaces, so one user accumulates none', async () => {
    const previous = [{ id: 'old-1' } as ApiKey, { id: 'old-2' } as ApiKey];
    const harness = build({ live: previous });

    await harness.resolver.chatCredential(USER, { workspaceId: 'ws-1' });

    expect(harness.revoke.mock.calls.map(([key]) => (key as ApiKey).id)).toEqual(['old-1', 'old-2']);
  });

  it('rotates only this user’s keys, so one member cannot break another’s open tab', async () => {
    // Rotating on workspace alone meant a second member opening the chat revoked
    // the key the first member's tab was holding — and a reload just reversed
    // who was broken. Two people chatting at once is the ordinary case for a
    // demo surface, so the lookup has to be narrowed to the caller.
    const harness = build({ live: [{ id: 'mine' } as ApiKey] });

    await harness.resolver.chatCredential(USER, { workspaceId: 'ws-1' });

    expect(harness.listLiveByPurpose).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      purpose: 'console_chat',
      createdByUserId: USER.id,
    });
  });

  it('is refused when the chat is switched off', async () => {
    const harness = build({ chat: { enabled: false } });

    await expect(harness.resolver.chatCredential(USER, { workspaceId: 'ws-1' })).rejects.toThrow(ForbiddenException);
    expect(harness.create).not.toHaveBeenCalled();
  });

  it('is refused when nothing in the catalogue can chat, rather than minting a useless key', async () => {
    const harness = build({ models: [model('vendor/embed', ['embeddings'])] });

    await expect(harness.resolver.chatCredential(USER, { workspaceId: 'ws-1' })).rejects.toThrow(
      /no chat-capable model/,
    );
    expect(harness.create).not.toHaveBeenCalled();
  });
});
