import type { IncomingHttpHeaders } from 'node:http';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
