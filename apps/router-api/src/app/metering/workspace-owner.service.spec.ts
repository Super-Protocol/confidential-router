import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDataSource } from '../../../test/seed.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { WorkspaceOwnerService } from './workspace-owner.service.js';

/**
 * The owner lookup, now that it is on a per-request path (SUP-542).
 *
 * `model_requested` resolves it for every `/v1` request, so the property under
 * test is that it costs one query per workspace rather than one per request —
 * and that the one state it must not remember is an absence.
 */

let dataSource: DataSource;
let service: WorkspaceOwnerService;

async function workspaceWithOwner(): Promise<{ workspaceId: string; ownerId: string }> {
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  await dataSource.getRepository(Workspace).save({
    id: workspaceId,
    name: 'Fixture',
    slug: `fixture-${workspaceId.slice(0, 8)}`,
    balanceMicros: 0,
    autoTopUpEnabled: false,
    createdAt: new Date(),
  });
  await dataSource
    .getRepository(WorkspaceMember)
    .save({ workspaceId, userId: ownerId, role: 'owner', createdAt: new Date() });
  return { workspaceId, ownerId };
}

beforeEach(async () => {
  dataSource = await createTestDataSource();
  service = new WorkspaceOwnerService(dataSource);
});

afterEach(async () => {
  await dataSource.destroy();
});

describe('resolving a workspace’s owner', () => {
  it('answers with the owner, not with another member', async () => {
    const { workspaceId, ownerId } = await workspaceWithOwner();
    await dataSource
      .getRepository(WorkspaceMember)
      .save({ workspaceId, userId: randomUUID(), role: 'member', createdAt: new Date() });

    expect(await service.ownerOf(workspaceId)).toBe(ownerId);
  });

  it('queries once however many requests ask', async () => {
    const { workspaceId, ownerId } = await workspaceWithOwner();
    const find = vi.spyOn(dataSource.getRepository(WorkspaceMember), 'findOne');

    expect(await service.ownerOf(workspaceId)).toBe(ownerId);
    expect(await service.ownerOf(workspaceId)).toBe(ownerId);
    expect(await service.ownerOf(workspaceId)).toBe(ownerId);

    // The point of the cache: a database round trip per `/v1` request, to resolve
    // an identifier that changes approximately never, is a cost with nothing to
    // show for it.
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('does not remember an absence, so a repair takes effect', async () => {
    const workspaceId = randomUUID();

    expect(await service.ownerOf(workspaceId)).toBeNull();
    const ownerId = randomUUID();
    await dataSource.getRepository(Workspace).save({
      id: workspaceId,
      name: 'Repaired',
      slug: `repaired-${workspaceId.slice(0, 8)}`,
      balanceMicros: 0,
      autoTopUpEnabled: false,
      createdAt: new Date(),
    });
    await dataSource
      .getRepository(WorkspaceMember)
      .save({ workspaceId, userId: ownerId, role: 'owner', createdAt: new Date() });

    expect(await service.ownerOf(workspaceId)).toBe(ownerId);
  });

  it('forgets on request, for whatever adds an ownership transfer', async () => {
    const { workspaceId, ownerId } = await workspaceWithOwner();
    expect(await service.ownerOf(workspaceId)).toBe(ownerId);

    const next = randomUUID();
    await dataSource.getRepository(WorkspaceMember).update({ workspaceId, role: 'owner' }, { userId: next });
    // Still the cached answer — which is the honest cost of the cache, and why
    // the invalidation hook exists rather than being left to be discovered.
    expect(await service.ownerOf(workspaceId)).toBe(ownerId);

    service.forget(workspaceId);
    expect(await service.ownerOf(workspaceId)).toBe(next);
  });
});
