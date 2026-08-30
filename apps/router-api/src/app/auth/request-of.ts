import type { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { Request } from 'express';
import type { SessionUser } from './auth.service.js';

export interface AuthenticatedRequest extends Request {
  sessionUser?: SessionUser;
}

/**
 * The Express request behind either transport.
 *
 * GraphQL resolvers and REST controllers share the same guard and the same
 * `@CurrentUser()`, and only this function needs to know that Apollo hides the
 * request one level down in the GraphQL context.
 */
export function requestOf(context: ExecutionContext): AuthenticatedRequest | undefined {
  if (context.getType<'graphql'>() === 'graphql') {
    return GqlExecutionContext.create(context).getContext<{ req?: AuthenticatedRequest }>().req;
  }
  return context.switchToHttp().getRequest<AuthenticatedRequest | undefined>();
}
