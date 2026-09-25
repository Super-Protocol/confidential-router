import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { requestOf } from './request-of.js';

/**
 * Operator-only reads: the caller's address has to be in `auth.adminEmails`.
 *
 * An address list rather than a role, because the `user` table belongs to Better
 * Auth and nothing here may add a column to it (ADR-004 §2). The list is empty by
 * default, so a deployment that has not named its operators refuses everyone —
 * the safe direction for a guard whose absence would expose a whole campaign.
 *
 * Always used behind `SessionGuard`, which is what puts `sessionUser` on the
 * request; on its own it would refuse every caller, which is also the safe
 * direction.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const email = requestOf(context)?.sessionUser?.email;
    const allowed = this.config.auth.adminEmails.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    if (!email || !allowed.includes(email.toLowerCase())) {
      // 403 and not 404: the caller is authenticated, and telling a signed-in
      // user that a query exists but is not theirs is not a leak worth avoiding.
      throw new ForbiddenException('This operation is restricted to deployment operators.');
    }
    return true;
  }
}
