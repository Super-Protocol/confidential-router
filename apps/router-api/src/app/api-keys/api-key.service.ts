import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiKey } from '../db/entities/api-key.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { displayPrefixOf, hashApiKey, looksLikeApiKey, mintApiKey } from './api-key-token.js';

export interface CreateApiKeyInput {
  workspaceId: string;
  createdByUserId: string;
  name: string;
  modelScope?: string[] | null;
  spendLimitMicros?: number | null;
  requestsPerMinute?: number | null;
  tokensPerMinute?: number | null;
  expiresAt?: Date | null;
}

export type UpdateApiKeyInput = Partial<Omit<CreateApiKeyInput, 'workspaceId' | 'createdByUserId'>>;

export interface CreatedApiKey {
  key: ApiKey;
  /** The plaintext. The caller has one chance to show it. */
  secret: string;
}

/** Why a presented credential was refused. Maps 1:1 to the 401 codes in the contract. */
export type ApiKeyRejection = 'invalid_api_key' | 'api_key_revoked' | 'api_key_expired';

export interface AuthenticatedApiKey {
  key: ApiKey;
  workspace: Workspace;
}

export type ApiKeyAuthResult = { ok: true; auth: AuthenticatedApiKey } | { ok: false; reason: ApiKeyRejection };

/**
 * CRUD and authentication for `/v1` credentials.
 *
 * The console never reads a key back: `create` is the only method that returns
 * plaintext, and it returns it once.
 */
@Injectable()
export class ApiKeyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private get keys() {
    return this.dataSource.getRepository(ApiKey);
  }

  async list(workspaceId: string): Promise<ApiKey[]> {
    return this.keys.find({ where: { workspaceId }, order: { createdAt: 'DESC' } });
  }

  async create(input: CreateApiKeyInput): Promise<CreatedApiKey> {
    const minted = mintApiKey();
    const key = this.keys.create({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      keyHash: minted.keyHash,
      prefix: minted.prefix,
      modelScope: normaliseScope(input.modelScope),
      spendLimitMicros: input.spendLimitMicros ?? null,
      spentTotalMicros: 0,
      requestsPerMinute: input.requestsPerMinute ?? null,
      tokensPerMinute: input.tokensPerMinute ?? null,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
      createdByUserId: input.createdByUserId,
      createdAt: new Date(),
    });
    await this.keys.save(key);
    return { key, secret: minted.secret };
  }

  /** Scoped by workspace, so an id from another tenant simply does not resolve. */
  async findInWorkspace(id: string, workspaceId: string): Promise<ApiKey | null> {
    return this.keys.findOne({ where: { id, workspaceId } });
  }

  async update(key: ApiKey, input: UpdateApiKeyInput): Promise<ApiKey> {
    // Assigned field by field rather than spread: an `undefined` in the input
    // means "leave it alone", and a spread would write it as `null`.
    if (input.name !== undefined) {
      key.name = input.name;
    }
    if (input.modelScope !== undefined) {
      key.modelScope = normaliseScope(input.modelScope);
    }
    if (input.spendLimitMicros !== undefined) {
      key.spendLimitMicros = input.spendLimitMicros;
    }
    if (input.requestsPerMinute !== undefined) {
      key.requestsPerMinute = input.requestsPerMinute;
    }
    if (input.tokensPerMinute !== undefined) {
      key.tokensPerMinute = input.tokensPerMinute;
    }
    if (input.expiresAt !== undefined) {
      key.expiresAt = input.expiresAt;
    }
    return this.keys.save(key);
  }

  /**
   * Revocation is a timestamp, not a delete: the generations metered against
   * the key have to keep resolving it.
   */
  async revoke(key: ApiKey): Promise<ApiKey> {
    key.revokedAt ??= new Date();
    return this.keys.save(key);
  }

  /**
   * Resolves a presented secret to a key and its workspace.
   *
   * The lookup is by `sha256(secret)` against a unique index — the stored form
   * is a hash, so there is nothing to compare in variable time.
   */
  async authenticate(secret: string, now: Date = new Date()): Promise<ApiKeyAuthResult> {
    if (!looksLikeApiKey(secret)) {
      return { ok: false, reason: 'invalid_api_key' };
    }
    const key = await this.keys.findOne({ where: { keyHash: hashApiKey(secret) } });
    if (!key) {
      return { ok: false, reason: 'invalid_api_key' };
    }
    if (key.revokedAt) {
      return { ok: false, reason: 'api_key_revoked' };
    }
    if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: 'api_key_expired' };
    }
    const workspace = await this.dataSource.getRepository(Workspace).findOne({ where: { id: key.workspaceId } });
    if (!workspace) {
      // The workspace was deleted but the key survived the cascade; treat the
      // credential as unusable rather than serving a tenant that is gone.
      return { ok: false, reason: 'invalid_api_key' };
    }
    return { ok: true, auth: { key, workspace } };
  }

  async markUsed(id: string, at: Date = new Date()): Promise<void> {
    await this.keys.update({ id }, { lastUsedAt: at });
  }

  /**
   * Adds a generation's cost to the key's running total, in SQL rather than
   * read-modify-write, so concurrent requests on one key cannot lose an update.
   */
  async recordSpend(id: string, costMicros: number): Promise<void> {
    if (costMicros <= 0) {
      return;
    }
    await this.keys
      .createQueryBuilder()
      .update(ApiKey)
      .set({ spentTotalMicros: () => `"spentTotalMicros" + ${Math.trunc(costMicros)}` })
      .where('id = :id', { id })
      .execute();
  }

  /** The display prefix a secret would get; used by tests and by the console. */
  static prefixOf(secret: string): string {
    return displayPrefixOf(secret);
  }
}

/** An empty scope list means "no restriction", which the column stores as `null`. */
function normaliseScope(scope: string[] | null | undefined): string[] | null {
  if (scope === undefined || scope === null || scope.length === 0) {
    return null;
  }
  return [...new Set(scope)];
}
