import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type AuthenticatedRequest, requestOf } from '../../../auth/index.js';

/**
 * Injects the Express request behind a GraphQL resolver.
 *
 * Only for the handful of operations that need the request itself rather than
 * the user the guard resolved from it — a Better Auth write, for instance, has
 * to re-read the caller's own cookie. Everything else takes `@CurrentUser()`.
 */
export const GqlRequest = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedRequest | undefined => requestOf(context),
);
