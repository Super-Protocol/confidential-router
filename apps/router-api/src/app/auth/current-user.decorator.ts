import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { SessionUser } from './auth.service.js';
import { requestOf } from './request-of.js';

/**
 * Injects the authenticated user resolved by `SessionGuard`.
 *
 * Only meaningful behind `@UseGuards(SessionGuard)`; without it the value is
 * `undefined`, which is why every handler that takes it also carries the guard.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionUser | undefined => requestOf(context)?.sessionUser,
);
