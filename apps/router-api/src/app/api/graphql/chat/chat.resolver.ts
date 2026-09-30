import { ForbiddenException, Inject, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ApiKeyService } from '../../../api-keys/api-key.service.js';
import { CurrentUser, SessionGuard, type SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import { CatalogService } from '../../../catalog/catalog.service.js';
import { routerConfig } from '../../../config.js';
import {
  ChatCredentialInputModel,
  ChatCredentialModel,
  ChatHistoryStorageEnum,
  ChatSettingsModel,
} from './chat.model.js';

/** The name the minted key carries, so the Keys table explains itself. */
export const CHAT_KEY_NAME = 'Console chat';

/**
 * The console Chat screen's two operations.
 *
 * There is deliberately no inference here and no conversation here. The chat
 * sends its messages to `/v1/chat/completions` like any other client, so the
 * only thing it needs from this schema is a credential to send them with; and
 * the history lives where `chatSettings.historyStorage` says it does, which
 * today is the visitor's own browser. Adding a `sendMessage` mutation would
 * create a second inference path and put prompt text on a surface that has
 * never carried any (`docs/contracts/data-model.md`, the `Generation`
 * invariant).
 */
@Resolver(() => ChatSettingsModel)
export class ChatResolver {
  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly apiKeys: ApiKeyService,
    private readonly workspaces: WorkspaceScopeService,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Public, like `models`: the screen needs the limits to render its composer
   * before anyone has signed in, and none of them is a fact about a viewer.
   */
  @Query(() => ChatSettingsModel, {
    name: 'chatSettings',
    description: 'Limits and history location for the console chat. Public.',
  })
  chatSettings(): ChatSettingsModel {
    const chat = this.config.chat;
    return {
      enabled: chat.enabled,
      maxMessageChars: chat.maxMessageChars,
      maxThreads: chat.maxThreads,
      maxMessagesPerThread: chat.maxMessagesPerThread,
      // Hard-coded, not configurable: a deployment must not be able to claim a
      // storage location it does not have. It changes when the code changes.
      historyStorage: ChatHistoryStorageEnum.BROWSER_LOCAL,
      chatModelIds: this.chatModelIds(),
    };
  }

  /**
   * Mints the chat's own key and revokes the one it replaces.
   *
   * Rotation rather than reuse, because the plaintext of the previous key was
   * shown once and is unrecoverable by design — there is nothing to hand back.
   * Revoking as we go is also what cleans up after a tab that closed without
   * ever spending its key.
   *
   * The scope is the chat-capable catalogue, so a leaked copy of this key can do
   * exactly what the screen could do and nothing else.
   */
  @Mutation(() => ChatCredentialModel, {
    description: 'A short-lived key for the console chat. Rotates: any previous chat key is revoked.',
  })
  @UseGuards(SessionGuard)
  async chatCredential(
    @CurrentUser() user: SessionUser,
    @Args('input') input: ChatCredentialInputModel,
  ): Promise<ChatCredentialModel> {
    if (!this.config.chat.enabled) {
      throw new ForbiddenException('The console chat is disabled on this deployment.');
    }
    const workspace = await this.workspaces.requireMembership(user.id, input.workspaceId);

    const modelScope = this.chatModelIds();
    if (modelScope.length === 0) {
      throw new ForbiddenException('This router serves no chat-capable model.');
    }

    for (const previous of await this.apiKeys.listLiveByPurpose(workspace.id, 'console_chat')) {
      await this.apiKeys.revoke(previous);
    }

    const created = await this.apiKeys.create({
      workspaceId: workspace.id,
      createdByUserId: user.id,
      name: CHAT_KEY_NAME,
      purpose: 'console_chat',
      modelScope,
      expiresAt: new Date(Date.now() + this.config.chat.credentialTtl),
    });

    return {
      apiKeyId: created.key.id,
      secret: created.secret,
      expiresAt: created.key.expiresAt as Date,
      baseUrl: `${this.config.server.publicBaseUrl.replace(/\/+$/, '')}/v1`,
      modelScope,
    };
  }

  /**
   * Chat-capable models only. A model that serves embeddings alone would fail
   * the request at LiteLLM, and offering it in the picker would make that the
   * user's mistake rather than ours.
   */
  private chatModelIds(): string[] {
    return this.catalog
      .list()
      .filter((model) => model.capabilities.includes('chat'))
      .map((model) => model.id);
  }
}
