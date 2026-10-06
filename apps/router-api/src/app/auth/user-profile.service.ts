import type { IncomingHttpHeaders } from 'node:http';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { User } from '../db/entities/user.entity.js';
import { AuthService, type SessionUser } from './auth.service.js';

/**
 * The console's view of the `user` row Better Auth owns (ADR-004 §2).
 *
 * Reads go through TypeORM's projection in `db/entities/user.entity.ts`, for the
 * one fact a session token does not carry — when the account was created, which
 * is "member since" on the Profile screen. Writes are delegated to
 * `AuthService`, because that entity is read-only and putting a second writer on
 * the auth tables is exactly what ADR-004 forbids.
 */
@Injectable()
export class UserProfileService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly auth: AuthService,
  ) {}

  /**
   * @throws NotFoundException when the row is gone — which, for a caller the
   *   session guard just authenticated, means the account was deleted mid-request.
   */
  async require(userId: string): Promise<User> {
    const user = await this.dataSource.getRepository(User).findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }
    return user;
  }

  /**
   * Addresses for a set of account ids, in one query.
   *
   * For the surfaces that record *who did this* — who registered an external
   * endpoint, who admitted a cloud (ADR-008 §7) — where the row holds an id
   * because Better Auth owns the `user` table and no foreign key may point at it
   * (ADR-004 §3). An id that no longer resolves is simply absent from the map:
   * the account was deleted, and "nobody" is the honest answer rather than a 404
   * for a list that is otherwise fine.
   */
  async emailsOf(userIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const users = await this.dataSource
      .getRepository(User)
      .find({ where: { id: In(ids) }, select: { id: true, email: true } });
    return new Map(users.map((user) => [user.id, user.email]));
  }

  /**
   * Renames the account the request's own cookie names.
   *
   * The headers travel through rather than a user id, so Better Auth resolves
   * the same session the guard did — an id from a resolver would be a way for
   * one caller to rename another's account.
   */
  async rename(headers: IncomingHttpHeaders, name: string): Promise<SessionUser> {
    return this.auth.updateProfile(headers, { name: name.trim() });
  }
}
