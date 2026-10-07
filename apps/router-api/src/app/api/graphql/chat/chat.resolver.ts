import { ForbiddenException, Inject, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ApiKeyService } from '../../../api-keys/api-key.service.js';
import { CurrentUser, SessionGuard, type SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import { CatalogService } from '../../../catalog/catalog.service.js';
import { ChatService } from '../../../chat/index.js';
import { routerConfig } from '../../../config.js';
import { ExternalCatalogService } from '../../../external-endpoints/index.js';
import {
  AppendChatMessageInputModel,
  ChatCredentialInputModel,
  ChatCredentialModel,
  ChatHistoryStorageEnum,
  ChatMessageModel,
  ChatSettingsModel,
  ChatThreadModel,
  CreateChatThreadInputModel,
} from './chat.model.js';

/** The name the minted key carries, so the Keys table explains itself. */
export const CHAT_KEY_NAME = 'Console chat';

/**
 * The console Chat screen's operations: a credential, the limits, and the
 * transcript.
 *
 * There is deliberately **no inference here**. The chat sends its messages to
 * `/v1/chat/completions` like any other client, and the mutations below only
 * *record* what was said afterwards. That distinction is the whole reason the
 * metering invariant still holds: a `sendMessage` mutation would be a second
 * inference path and would put prompt text on the surface `generations` is
 * guarded to keep clean.
 *
 * Recording is two calls, not one, and that is deliberate too: the user's turn
 * is stored when it is sent, the model's when the stream settles. A tab that
 * dies mid-answer therefore leaves a question in the transcript rather than
 * losing the turn entirely.
 */
@Resolver(() => ChatSettingsModel)
export class ChatResolver {
  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly apiKeys: ApiKeyService,
    private readonly workspaces: WorkspaceScopeService,
    private readonly catalog: CatalogService,
    private readonly external: ExternalCatalogService,
    private readonly chat: ChatService,
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
      // storage location it does not have. It changes when the code changes —
      // and it changed here when Denis unblocked server-side history, so the
      // tables below are what this now describes.
      historyStorage: ChatHistoryStorageEnum.ATTESTED_SERVER,
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
   * Rotation is scoped to `(workspace, this user)`, not to the workspace. A
   * workspace has members, and revoking every chat key in it would mean one
   * person opening the chat silently breaking the tab another person has open —
   * for as long as their cached secret would otherwise have lasted. Two members
   * chatting at once is the ordinary case for a demo surface, not an edge one.
   *
   * The model scope is the chat-capable catalogue, so a leaked copy of this key
   * can do exactly what the screen could do and nothing else.
   */
  @Mutation(() => ChatCredentialModel, {
    description:
      'A short-lived key for the console chat. Rotates: this user’s own previous chat key in the workspace ' +
      'is revoked, and no one else’s.',
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

    const superseded = await this.apiKeys.listLiveByPurpose({
      workspaceId: workspace.id,
      purpose: 'console_chat',
      createdByUserId: user.id,
    });
    for (const previous of superseded) {
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

  @Query(() => [ChatThreadModel], {
    name: 'chatThreads',
    description: 'This member’s conversations in the workspace, most recently used first. Titles only.',
  })
  @UseGuards(SessionGuard)
  async chatThreads(
    @CurrentUser() user: SessionUser,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
  ): Promise<ChatThreadModel[]> {
    const scope = await this.scopeFor(user, workspaceId);
    return (await this.chat.listThreads(scope)).map((thread) => ChatThreadModel.from(thread));
  }

  @Query(() => ChatThreadModel, {
    name: 'chatThread',
    description: 'One conversation with its turns, oldest first.',
  })
  @UseGuards(SessionGuard)
  async chatThread(
    @CurrentUser() user: SessionUser,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
    @Args('threadId', { type: () => ID }) threadId: string,
  ): Promise<ChatThreadModel> {
    const scope = await this.scopeFor(user, workspaceId);
    const { thread, messages } = await this.chat.threadWithMessages(scope, threadId);
    return ChatThreadModel.from(thread, messages);
  }

  @Mutation(() => ChatThreadModel, {
    description: 'Starts a conversation. The member’s oldest is pruned when they are at `maxThreads`.',
  })
  @UseGuards(SessionGuard)
  async createChatThread(
    @CurrentUser() user: SessionUser,
    @Args('input') input: CreateChatThreadInputModel,
  ): Promise<ChatThreadModel> {
    this.assertEnabled();
    const scope = await this.scopeFor(user, input.workspaceId);
    this.assertChatModel(input.modelId);
    return ChatThreadModel.from(await this.chat.createThread(scope, input.modelId));
  }

  @Mutation(() => ChatThreadModel, { description: 'Switches the model a conversation talks to.' })
  @UseGuards(SessionGuard)
  async setChatThreadModel(
    @CurrentUser() user: SessionUser,
    @Args('input') input: CreateChatThreadInputModel,
    @Args('threadId', { type: () => ID }) threadId: string,
  ): Promise<ChatThreadModel> {
    this.assertEnabled();
    const scope = await this.scopeFor(user, input.workspaceId);
    this.assertChatModel(input.modelId);
    return ChatThreadModel.from(await this.chat.setThreadModel(scope, threadId, input.modelId));
  }

  @Mutation(() => ChatMessageModel, {
    description:
      'Records one turn that has already happened. This does not call a model — the browser does that ' +
      'over /v1/chat/completions, like any other client.',
  })
  @UseGuards(SessionGuard)
  async appendChatMessage(
    @CurrentUser() user: SessionUser,
    @Args('input') input: AppendChatMessageInputModel,
  ): Promise<ChatMessageModel> {
    this.assertEnabled();
    const scope = await this.scopeFor(user, input.workspaceId);
    return ChatMessageModel.from(
      await this.chat.appendMessage({
        ...scope,
        threadId: input.threadId,
        role: input.role,
        content: input.content,
        error: input.error ?? null,
      }),
    );
  }

  @Mutation(() => Boolean, {
    description: 'Deletes a conversation and its turns outright. There is no archive and no tombstone.',
  })
  @UseGuards(SessionGuard)
  async deleteChatThread(
    @CurrentUser() user: SessionUser,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
    @Args('threadId', { type: () => ID }) threadId: string,
  ): Promise<boolean> {
    const scope = await this.scopeFor(user, workspaceId);
    await this.chat.deleteThread(scope, threadId);
    return true;
  }

  /**
   * The scope every transcript query carries.
   *
   * `requireMembership` first, so a workspace id the viewer is not a member of
   * fails before any thread is looked up; then the viewer's own id, so one
   * member of a workspace cannot read another's conversation.
   */
  private async scopeFor(user: SessionUser, workspaceId: string): Promise<{ workspaceId: string; userId: string }> {
    const workspace = await this.workspaces.requireMembership(user.id, workspaceId);
    return { workspaceId: workspace.id, userId: user.id };
  }

  private assertEnabled(): void {
    if (!this.config.chat.enabled) {
      throw new ForbiddenException('The console chat is disabled on this deployment.');
    }
  }

  /** A thread may only name a model the chat is allowed to use. */
  private assertChatModel(modelId: string): void {
    if (!this.chatModelIds().includes(modelId)) {
      throw new ForbiddenException(`"${modelId}" is not a chat-capable model on this router.`);
    }
  }

  /**
   * Chat-capable models only. A model that serves embeddings alone would fail
   * the request at LiteLLM, and offering it in the picker would make that the
   * user's mistake rather than ours.
   *
   * External models join the same list, and the filter that decides *which* is
   * the one the API already owns: `ExternalCatalogService.list()` holds a model
   * **iff** its endpoint is enabled and holds a live verdict admitting it
   * (ADR-008 decision 5). So an upstream that fails a re-attestation leaves the
   * picker on the next refresh and leaves the scope of the next chat credential,
   * without the screen having to know what a verdict is — which is the same
   * division of labour chat capability already had.
   *
   * It is also, deliberately, the scope every chat key is minted with. A key that
   * could reach a model the picker would not offer would be the gate living in
   * the browser.
   */
  private chatModelIds(): string[] {
    const builtIn = this.catalog.list().filter((model) => model.capabilities.includes('chat'));
    const external = this.external.list().filter((model) => model.capabilities.includes('chat'));
    return [...builtIn, ...external].map((model) => model.id);
  }
}
