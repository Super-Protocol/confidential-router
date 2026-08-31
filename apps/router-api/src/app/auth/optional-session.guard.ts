import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { requestOf } from './request-of.js';

/**
 * Resolves a session when there is one, and lets the request through when there
 * is not.
 *
 * For the one part of the console API that is public: the model catalogue. A
 * router that meters LLM traffic has to be able to say what it routes to before
 * anyone signs up, exactly as its `/v1`-facing peers do — but a signed-in
 * caller still gets their own usage figures on the same query, which is why the
 * session is resolved rather than skipped.
 *
 * It never throws. `@CurrentUser()` behind this guard is `SessionUser |
 * undefined`, and a resolver that uses it has to handle the anonymous case.
 */
@Injectable()
export class OptionalSessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestOf(context);
    if (request) {
      request.sessionUser = (await this.authService.getSessionUser(request.headers)) ?? undefined;
    }
    return true;
  }
}
