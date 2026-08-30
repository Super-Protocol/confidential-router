import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthService, SessionUser } from './auth.service.js';
import { SessionGuard } from './session.guard.js';

const USER: SessionUser = { id: 'user-1', email: 'dev@example.com', name: 'Dev', image: null };

function httpContext(request: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function graphqlContext(request: unknown): ExecutionContext {
  const args = [undefined, undefined, { req: request }, undefined];
  return {
    getType: () => 'graphql',
    getClass: () => class {},
    getHandler: () => () => undefined,
    getArgs: () => args,
    getArgByIndex: (index: number) => args[index],
  } as unknown as ExecutionContext;
}

function guardWith(user: SessionUser | null): { guard: SessionGuard; getSessionUser: ReturnType<typeof vi.fn> } {
  const getSessionUser = vi.fn().mockResolvedValue(user);
  return { guard: new SessionGuard({ getSessionUser } as unknown as AuthService), getSessionUser };
}

describe('SessionGuard', () => {
  it('admits a request with a valid session and attaches the user', async () => {
    const request: Record<string, unknown> = { headers: { cookie: 'cr_session=valid' } };
    const { guard, getSessionUser } = guardWith(USER);

    await expect(guard.canActivate(httpContext(request))).resolves.toBe(true);

    expect(request.sessionUser).toEqual(USER);
    expect(getSessionUser).toHaveBeenCalledWith(request.headers);
  });

  it('rejects a request with no session', async () => {
    const { guard } = guardWith(null);

    await expect(guard.canActivate(httpContext({ headers: {} }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('resolves the request through the GraphQL context too', async () => {
    const request: Record<string, unknown> = { headers: { cookie: 'cr_session=valid' } };
    const { guard } = guardWith(USER);

    await expect(guard.canActivate(graphqlContext(request))).resolves.toBe(true);
    expect(request.sessionUser).toEqual(USER);
  });

  it('rejects rather than throwing when there is no request at all', async () => {
    const { guard } = guardWith(USER);
    const contextWithoutRequest = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => undefined }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(contextWithoutRequest)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('never accepts an API key in place of a session', async () => {
    // `/v1/*` authenticates with a bearer key and the console with a cookie;
    // the two must not be interchangeable (ADR-004 §6).
    const request = { headers: { authorization: 'Bearer sk-tee-v1-anything' } };
    const { guard, getSessionUser } = guardWith(null);

    await expect(guard.canActivate(httpContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(getSessionUser).toHaveBeenCalledOnce();
  });
});
