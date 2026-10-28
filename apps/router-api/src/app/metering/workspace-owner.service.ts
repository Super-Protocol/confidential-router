import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';

/**
 * How many workspaces' owners are remembered at once.
 *
 * A bound rather than an unbounded map: this is read on the `/v1` path, and a
 * cache on a request path with no ceiling is a slow leak waiting for a deployment
 * with more accounts than anybody tested with. Oldest insertion is dropped first,
 * which for this access pattern — the same handful of workspaces sending traffic
 * all day — behaves like a working set.
 */
const CACHE_LIMIT = 1_000;

/**
 * Which account a workspace's events are attributed to: its owner.
 *
 * Read from `workspace_members` rather than carried on the request, because a
 * `/v1` request authenticates with an API key and a key has no user — the account
 * that created it may have left the workspace since.
 *
 * Cached because {@link ownerOf} is now on a per-request path (`model_requested`,
 * SUP-542) and a database round trip per request to resolve an identifier that
 * changes approximately never is a cost with nothing to show for it. Ownership is
 * set when the personal workspace is created and the product has no transfer
 * path; if one is ever added, it has to clear this.
 */
@Injectable()
export class WorkspaceOwnerService {
  private readonly owners = new Map<string, string>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async ownerOf(workspaceId: string): Promise<string | null> {
    const cached = this.owners.get(workspaceId);
    if (cached !== undefined) {
      return cached;
    }
    const owner = await this.dataSource
      .getRepository(WorkspaceMember)
      .findOne({ where: { workspaceId, role: 'owner' } });

    if (!owner) {
      // Not cached: a workspace with no owner cannot happen —
      // `ensurePersonalWorkspace` writes one with the workspace — so if it
      // somehow does, it is a state that may be repaired, and remembering the
      // absence would outlive the repair.
      return null;
    }
    this.remember(workspaceId, owner.userId);
    return owner.userId;
  }

  /** Forgets one workspace, for a test and for whatever adds an ownership transfer. */
  forget(workspaceId: string): void {
    this.owners.delete(workspaceId);
  }

  private remember(workspaceId: string, userId: string): void {
    if (this.owners.size >= CACHE_LIMIT) {
      const oldest = this.owners.keys().next();
      if (!oldest.done) {
        this.owners.delete(oldest.value);
      }
    }
    this.owners.set(workspaceId, userId);
  }
}
