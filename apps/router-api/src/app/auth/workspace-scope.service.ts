import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember, type WorkspaceRole } from '../db/entities/workspace-member.entity.js';

export interface WorkspaceMembership {
  workspace: Workspace;
  role: WorkspaceRole;
}

/**
 * Every workspace-scoped read and write goes through here.
 *
 * Tenancy is the one thing a router that meters money per workspace cannot get
 * wrong, so the membership check lives in a single service with its own tests
 * rather than being repeated — and eventually forgotten — in each resolver.
 */
@Injectable()
export class WorkspaceScopeService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Every workspace the user belongs to, with the role they hold in it. */
  async listForUser(userId: string): Promise<WorkspaceMembership[]> {
    const memberships = await this.dataSource.getRepository(WorkspaceMember).find({
      where: { userId },
      relations: { workspace: true },
      order: { createdAt: 'ASC' },
    });
    return memberships.flatMap((membership) =>
      membership.workspace ? [{ workspace: membership.workspace, role: membership.role }] : [],
    );
  }

  /** The workspace the console opens on: the oldest one the user owns. */
  async defaultForUser(userId: string): Promise<Workspace | null> {
    const membership = await this.dataSource.getRepository(WorkspaceMember).findOne({
      where: { userId, role: 'owner' },
      relations: { workspace: true },
      order: { createdAt: 'ASC' },
    });
    return membership?.workspace ?? null;
  }

  async roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const membership = await this.dataSource.getRepository(WorkspaceMember).findOne({ where: { userId, workspaceId } });
    return membership?.role ?? null;
  }

  /**
   * Resolves a workspace the user may act in, or refuses.
   *
   * A non-member gets `403`, not `404`: the workspace id came from the caller,
   * and answering "no such workspace" for one that exists would turn this into
   * an existence oracle for other tenants' slugs.
   */
  async requireMembership(
    userId: string,
    workspaceId: string,
    minimumRole: WorkspaceRole = 'member',
  ): Promise<Workspace> {
    const role = await this.roleOf(userId, workspaceId);
    if (!role || (minimumRole === 'owner' && role !== 'owner')) {
      throw new ForbiddenException('You do not have access to this workspace.');
    }
    const workspace = await this.dataSource.getRepository(Workspace).findOne({ where: { id: workspaceId } });
    if (!workspace) {
      throw new NotFoundException('Workspace not found.');
    }
    return workspace;
  }
}
