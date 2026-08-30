import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { requestOf } from './request-of.js';

/**
 * Console authentication: session cookie in, `request.sessionUser` out.
 *
 * API keys are deliberately not accepted here. `/v1/*` authenticates with
 * `Authorization: Bearer sk-tee-v1-…` and nothing else, the console with a
 * cookie and nothing else (ADR-004 §6) — keeping the two guards separate is what
 * makes that property checkable rather than aspirational.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestOf(context);
    if (!request) {
      throw new UnauthorizedException('Authentication is required.');
    }

    const user = await this.authService.getSessionUser(request.headers);
    if (!user) {
      throw new UnauthorizedException('Authentication is required.');
    }

    request.sessionUser = user;
    return true;
  }
}
