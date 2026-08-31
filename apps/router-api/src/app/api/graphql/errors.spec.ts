import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { describe, expect, it } from 'vitest';
import { formatConsoleError, INTERNAL_ERROR_MESSAGE } from './errors.js';

/** What Apollo hands `formatError`: the formatted error, and the thing that was thrown. */
function thrown(error: unknown, extensions: Record<string, unknown> = {}) {
  const wrapped = new GraphQLError(error instanceof Error ? error.message : String(error), {
    originalError: error as Error,
    extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['at somewhere'], ...extensions },
  });
  const formatted: GraphQLFormattedError = {
    message: wrapped.message,
    extensions: wrapped.extensions,
  };
  return [formatted, wrapped] as const;
}

describe('formatConsoleError', () => {
  it.each([
    [new UnauthorizedException('Authentication is required.'), 'UNAUTHENTICATED', 401],
    [new ForbiddenException('You do not have access to this workspace.'), 'FORBIDDEN', 403],
    [new NotFoundException('API key not found.'), 'NOT_FOUND', 404],
    [new BadRequestException('spendLimitMicros must be a whole number.'), 'BAD_USER_INPUT', 400],
  ])('maps %# to a stable code a client can branch on', (exception, code, status) => {
    const [formatted, raw] = thrown(exception);

    const result = formatConsoleError(formatted, raw, true);

    expect(result.extensions).toMatchObject({ code, status });
    expect(result.message).toBe(exception.message);
  });

  it('finds the status through a doubly wrapped error', () => {
    const inner = new GraphQLError('wrapped', { originalError: new ForbiddenException('nope') });
    const [formatted, raw] = thrown(inner);

    expect(formatConsoleError(formatted, raw, true).extensions?.code).toBe('FORBIDDEN');
  });

  it('keeps the codes Apollo assigns before a resolver runs', () => {
    const [formatted, raw] = thrown(new GraphQLError('Cannot query field "nope"'), {
      code: 'GRAPHQL_VALIDATION_FAILED',
    });

    expect(formatConsoleError(formatted, raw, true).extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it('replaces the message of an unmapped failure when internals are not exposed', () => {
    // A driver or ORM message is exactly the sort of thing that leaks a table
    // name or a connection string.
    const [formatted, raw] = thrown(new Error('SQLITE_CONSTRAINT: UNIQUE failed: api_keys.hash'));

    const result = formatConsoleError(formatted, raw, false);

    expect(result.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(result.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('keeps the message and the stack when internals are exposed', () => {
    const [formatted, raw] = thrown(new Error('boom'));

    const result = formatConsoleError(formatted, raw, true);

    expect(result.message).toBe('boom');
    expect(result.extensions?.stacktrace).toEqual(['at somewhere']);
  });

  it('does not blank a mapped 4xx message in production — the client caused it', () => {
    const [formatted, raw] = thrown(new BadRequestException('The evidence retention window must be 1–3650 days.'));

    const result = formatConsoleError(formatted, raw, false);

    expect(result.message).toBe('The evidence retention window must be 1–3650 days.');
    expect(result.extensions?.stacktrace).toBeUndefined();
  });

  it('treats an unlisted 5xx as internal and an unlisted 4xx as a bad request', () => {
    const [serverFormatted, serverRaw] = thrown(new InternalServerErrorException('boom'));
    const [clientFormatted, clientRaw] = thrown(new BadRequestException('x'), { code: 'X' });

    expect(formatConsoleError(serverFormatted, serverRaw, true).extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(formatConsoleError(clientFormatted, clientRaw, true).extensions?.code).toBe('BAD_USER_INPUT');
  });
});
