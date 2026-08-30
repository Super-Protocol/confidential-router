import { BadRequestException, NotFoundException, UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ApiKeyService } from '../../../api-keys/api-key.service.js';
import { CurrentUser, SessionGuard, type SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import { CatalogService } from '../../../catalog/catalog.service.js';
import type { ApiKey } from '../../../db/entities/api-key.entity.js';
import { ApiKeyCreatedModel, ApiKeyModel, CreateApiKeyInputModel, UpdateApiKeyInputModel } from './api-key.model.js';

/**
 * API key management for the console.
 *
 * Session cookie only — a `/v1` key cannot mint another `/v1` key. Every
 * operation resolves the workspace through `WorkspaceScopeService` first, so a
 * key id from another tenant is simply not found.
 */
@Resolver(() => ApiKeyModel)
@UseGuards(SessionGuard)
export class ApiKeysResolver {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly workspaces: WorkspaceScopeService,
    private readonly catalog: CatalogService,
  ) {}

  @Query(() => [ApiKeyModel], { name: 'apiKeys', description: 'Every key in the workspace, newest first.' })
  async list(
    @CurrentUser() user: SessionUser,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
  ): Promise<ApiKeyModel[]> {
    await this.workspaces.requireMembership(user.id, workspaceId);
    return (await this.apiKeys.list(workspaceId)).map(present);
  }

  @Mutation(() => ApiKeyCreatedModel, {
    description: 'Creates a key and returns its secret. The secret is never retrievable again.',
  })
  async createApiKey(
    @CurrentUser() user: SessionUser,
    @Args('input') input: CreateApiKeyInputModel,
  ): Promise<ApiKeyCreatedModel> {
    await this.workspaces.requireMembership(user.id, input.workspaceId);
    this.assertKnownModels(input.modelIds);

    const created = await this.apiKeys.create({
      workspaceId: input.workspaceId,
      createdByUserId: user.id,
      name: input.name,
      modelScope: input.modelIds ?? null,
      spendLimitMicros: micros(input.spendLimitMicros),
      requestsPerMinute: input.requestsPerMinute ?? null,
      tokensPerMinute: input.tokensPerMinute ?? null,
      expiresAt: input.expiresAt ?? null,
    });
    return { key: present(created.key), secret: created.secret };
  }

  @Mutation(() => ApiKeyModel)
  async updateApiKey(
    @CurrentUser() user: SessionUser,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateApiKeyInputModel,
  ): Promise<ApiKeyModel> {
    this.assertKnownModels(input.modelIds);
    const key = await this.require(user, id);
    return present(
      await this.apiKeys.update(key, {
        name: input.name,
        modelScope: input.modelIds,
        spendLimitMicros: input.spendLimitMicros === undefined ? undefined : micros(input.spendLimitMicros),
        requestsPerMinute: input.requestsPerMinute,
        tokensPerMinute: input.tokensPerMinute,
        expiresAt: input.expiresAt,
      }),
    );
  }

  @Mutation(() => ApiKeyModel, { description: 'Revokes a key. Idempotent; the row is kept for its generations.' })
  async revokeApiKey(
    @CurrentUser() user: SessionUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ApiKeyModel> {
    return present(await this.apiKeys.revoke(await this.require(user, id)));
  }

  /**
   * Resolves a key the user may act on.
   *
   * The lookup walks the user's workspaces rather than trusting a workspace id
   * from the client: the key id alone has to be enough, and it has to be
   * useless outside the tenant that owns it.
   */
  private async require(user: SessionUser, id: string): Promise<ApiKey> {
    for (const { workspace } of await this.workspaces.listForUser(user.id)) {
      const key = await this.apiKeys.findInWorkspace(id, workspace.id);
      if (key) {
        return key;
      }
    }
    throw new NotFoundException('API key not found.');
  }

  /** A scope naming a model that does not exist would silently disable the key. */
  private assertKnownModels(modelIds: string[] | undefined): void {
    const unknown = (modelIds ?? []).filter((id) => !this.catalog.find(id));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown model id(s): ${unknown.join(', ')}.`);
    }
  }
}

function present(key: ApiKey): ApiKeyModel {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    modelScope: key.modelScope,
    spendLimitMicros: key.spendLimitMicros === null ? null : String(key.spendLimitMicros),
    spentTotalMicros: String(key.spentTotalMicros),
    requestsPerMinute: key.requestsPerMinute,
    tokensPerMinute: key.tokensPerMinute,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
  };
}

function micros(value: string | undefined): number | null {
  return value === undefined ? null : Number(value);
}
