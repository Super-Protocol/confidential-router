import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';

/** Longest slug we will store; leaves room for the disambiguating suffix. */
const MAX_SLUG_LENGTH = 48;

@Injectable()
export class WorkspaceProvisioningService {
  private readonly logger = new Logger(WorkspaceProvisioningService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Gives a brand-new user their personal workspace, as owner.
   *
   * Idempotent: a user who already owns a workspace gets nothing new, so a
   * replayed Better Auth hook or a retried sign-in cannot mint duplicates.
   */
  async ensurePersonalWorkspace(user: { id: string; email: string; name?: string | null }): Promise<Workspace> {
    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(WorkspaceMember, {
        where: { userId: user.id, role: 'owner' },
        relations: { workspace: true },
      });
      if (existing?.workspace) {
        return existing.workspace;
      }

      const workspace = manager.create(Workspace, {
        id: randomUUID(),
        name: user.name?.trim() || user.email,
        slug: await this.allocateSlug(manager, user.email),
        balanceMicros: 0,
        autoTopUpEnabled: false,
        createdAt: new Date(),
      });
      await manager.save(Workspace, workspace);
      await manager.save(
        manager.create(WorkspaceMember, {
          workspaceId: workspace.id,
          userId: user.id,
          role: 'owner',
          createdAt: new Date(),
        }),
      );

      this.logger.log(`Provisioned personal workspace ${workspace.slug} for user ${user.id}`);
      return workspace;
    });
  }

  /**
   * Slugs are unique and user-visible, so a collision has to resolve to
   * something stable rather than failing the sign-in that triggered it.
   */
  private async allocateSlug(manager: DataSource['manager'], email: string): Promise<string> {
    const base =
      email
        .split('@')[0]
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_SLUG_LENGTH) || 'workspace';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${randomUUID().slice(0, 6)}`;
      const taken = await manager.exists(Workspace, { where: { slug: candidate } });
      if (!taken) {
        return candidate;
      }
    }
    return `${base}-${randomUUID()}`;
  }
}
