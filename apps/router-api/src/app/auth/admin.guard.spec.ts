import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../../test/seed.js';
import { AdminGuard } from './admin.guard.js';

/** The `ExecutionContext` shape `requestOf` reads for an HTTP request. */
function contextFor(email: string | null): ExecutionContext {
  const request = email === null ? {} : { sessionUser: { id: 'u1', email, name: null, image: null } };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardWith(adminEmails?: string): AdminGuard {
  return new AdminGuard(testConfig(adminEmails === undefined ? {} : { CR_API_AUTH__ADMIN_EMAILS: adminEmails }));
}

describe('AdminGuard', () => {
  it('admits an address the deployment named', async () => {
    expect(await guardWith('ops@example.test').canActivate(contextFor('ops@example.test'))).toBe(true);
  });

  it('compares addresses case-insensitively, because mail does', async () => {
    expect(await guardWith('Ops@Example.test').canActivate(contextFor('ops@EXAMPLE.test'))).toBe(true);
  });

  it('admits any address on the list', async () => {
    const guard = guardWith('first@example.test,second@example.test');

    expect(await guard.canActivate(contextFor('second@example.test'))).toBe(true);
  });

  it('refuses a signed-in user who is not on the list', async () => {
    await expect(guardWith('ops@example.test').canActivate(contextFor('someone@example.test'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses everyone when the deployment named nobody — the default', async () => {
    await expect(guardWith().canActivate(contextFor('ops@example.test'))).rejects.toThrow(ForbiddenException);
  });

  it('refuses an anonymous request, so it is safe even without SessionGuard in front', async () => {
    await expect(guardWith('ops@example.test').canActivate(contextFor(null))).rejects.toThrow(ForbiddenException);
  });
});
