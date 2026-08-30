import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDataSourceOptions } from '../db/data-source.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { WorkspaceProvisioningService } from './workspace-provisioning.service.js';
import { WorkspaceScopeService } from './workspace-scope.service.js';

/**
 * Backed by a real migrated SQLite database rather than a mocked repository:
 * the behaviour under test is uniqueness, transactions and membership filtering,
 * none of which a mock would actually exercise.
 */

let dir: string;
let dataSource: DataSource;
let provisioning: WorkspaceProvisioningService;
let scope: WorkspaceScopeService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cr-workspace-'));
  dataSource = new DataSource(
    buildDataSourceOptions({ type: 'sqlite', file: join(dir, 'router.sqlite'), migrationsRun: false, logging: false }),
  );
  await dataSource.initialize();
  await dataSource.runMigrations();
  provisioning = new WorkspaceProvisioningService(dataSource);
  scope = new WorkspaceScopeService(dataSource);
});

afterEach(async () => {
  await dataSource?.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe('WorkspaceProvisioningService', () => {
  it('creates a personal workspace whose owner is the new user', async () => {
    const workspace = await provisioning.ensurePersonalWorkspace({ id: 'u1', email: 'dev@example.com', name: 'Dev' });

    expect(workspace).toMatchObject({ name: 'Dev', slug: 'dev', balanceMicros: 0 });
    expect(await scope.roleOf('u1', workspace.id)).toBe('owner');
  });

  it('falls back to the email address when the user has no name', async () => {
    const workspace = await provisioning.ensurePersonalWorkspace({ id: 'u1', email: 'dev@example.com', name: '  ' });
    expect(workspace.name).toBe('dev@example.com');
  });

  it('is idempotent, so a replayed sign-in hook mints no second workspace', async () => {
    const user = { id: 'u1', email: 'dev@example.com', name: 'Dev' };
    const first = await provisioning.ensurePersonalWorkspace(user);
    const second = await provisioning.ensurePersonalWorkspace(user);

    expect(second.id).toBe(first.id);
    expect(await dataSource.getRepository(Workspace).count()).toBe(1);
  });

  it('disambiguates a slug two users would otherwise share', async () => {
    const first = await provisioning.ensurePersonalWorkspace({ id: 'u1', email: 'dev@example.com' });
    const second = await provisioning.ensurePersonalWorkspace({ id: 'u2', email: 'dev@other.example' });

    expect(first.slug).toBe('dev');
    expect(second.slug).toMatch(/^dev-[0-9a-f]{6}$/);
  });

  it('produces a usable slug from an email with no slug-safe characters', async () => {
    const workspace = await provisioning.ensurePersonalWorkspace({ id: 'u1', email: '___@example.com' });
    expect(workspace.slug).toBe('workspace');
  });
});

describe('WorkspaceScopeService', () => {
  beforeEach(async () => {
    await provisioning.ensurePersonalWorkspace({ id: 'owner', email: 'owner@example.com', name: 'Owner' });
    await provisioning.ensurePersonalWorkspace({ id: 'other', email: 'other@example.com', name: 'Other' });
  });

  async function ownedBy(userId: string): Promise<Workspace> {
    const workspace = await scope.defaultForUser(userId);
    if (!workspace) {
      throw new Error(`No workspace for ${userId}`);
    }
    return workspace;
  }

  it('lists only the workspaces the user belongs to', async () => {
    const memberships = await scope.listForUser('owner');

    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ role: 'owner' });
    expect(memberships[0].workspace.slug).toBe('owner');
  });

  it('returns no workspaces for a user with no memberships', async () => {
    expect(await scope.listForUser('stranger')).toEqual([]);
    expect(await scope.defaultForUser('stranger')).toBeNull();
  });

  it('resolves a workspace the user belongs to', async () => {
    const workspace = await ownedBy('owner');
    await expect(scope.requireMembership('owner', workspace.id)).resolves.toMatchObject({ id: workspace.id });
  });

  it("refuses another tenant's workspace", async () => {
    const foreign = await ownedBy('other');

    await expect(scope.requireMembership('owner', foreign.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 403 for a workspace that does not exist, not 404', async () => {
    // A 404 here would tell the caller which workspace ids are real.
    await expect(scope.requireMembership('owner', 'does-not-exist')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a plain member when owner rights are required', async () => {
    const workspace = await ownedBy('owner');
    await dataSource.getRepository(WorkspaceMember).save({
      workspaceId: workspace.id,
      userId: 'guest',
      role: 'member',
      createdAt: new Date(),
    });

    await expect(scope.requireMembership('guest', workspace.id)).resolves.toMatchObject({ id: workspace.id });
    await expect(scope.requireMembership('guest', workspace.id, 'owner')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
