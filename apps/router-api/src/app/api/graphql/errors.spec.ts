import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { describe, expect, it } from 'vitest';
import { validationException } from '../../common/validation-error.js';
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
    [new ServiceUnavailableException('Buying credits is switched off on this deployment.'), 'SERVICE_UNAVAILABLE', 503],
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

  it('lets a deliberate 503 refusal speak in production — it is policy, not a fault', () => {
    // A deployment that sells no credit refuses `createCheckout` with a sentence
    // written for the user (SUP-171). Masking it told the caller the server had
    // broken, and made our own error text unreachable.
    const [formatted, raw] = thrown(
      new ServiceUnavailableException('Buying credits is switched off on this deployment.'),
    );

    const result = formatConsoleError(formatted, raw, false);

    expect(result.message).toBe('Buying credits is switched off on this deployment.');
    expect(result.extensions).toEqual({ code: 'SERVICE_UNAVAILABLE', status: 503 });
  });

  /*
   * SUP-295 item 2. A validation refusal used to arrive as the literal string
   * "Bad Request Exception" — `HttpException.message` for a response object —
   * with the real messages inside `originalError`, which production deletes.
   * The console had nothing to show and fell back to "The request failed."
   */
  it('says what was wrong with a validated input, and under which field', () => {
    const [formatted, raw] = thrown(
      validationException([
        { property: 'spendLimitMicros', constraints: { matches: 'spendLimitMicros must match /^\\d{1,15}$/' } },
      ] as never),
    );

    const result = formatConsoleError(formatted, raw, false);

    expect(result.message).toBe('spendLimitMicros must match /^\\d{1,15}$/');
    expect(result.extensions).toMatchObject({
      code: 'BAD_USER_INPUT',
      status: 400,
      fields: { spendLimitMicros: 'spendLimitMicros must match /^\\d{1,15}$/' },
    });
  });

  it('joins several refusals rather than showing one and hiding the rest', () => {
    const [formatted, raw] = thrown(
      validationException([
        { property: 'name', constraints: { isString: 'name must be a string' } },
        { property: 'requestsPerMinute', constraints: { min: 'requestsPerMinute must not be less than 1' } },
      ] as never),
    );

    const result = formatConsoleError(formatted, raw, false);

    expect(result.message).toBe('name must be a string requestsPerMinute must not be less than 1');
    expect(result.extensions?.fields).toEqual({
      name: 'name must be a string',
      requestsPerMinute: 'requestsPerMinute must not be less than 1',
    });
  });

  it('leaves an ordinary refusal alone — there is no field to name', () => {
    const [formatted, raw] = thrown(new BadRequestException('Unknown model id(s): nope.'));

    const result = formatConsoleError(formatted, raw, false);

    expect(result.message).toBe('Unknown model id(s): nope.');
    expect(result.extensions).not.toHaveProperty('fields');
  });

  it('treats an unlisted 5xx as internal and an unlisted 4xx as a bad request', () => {
    const [serverFormatted, serverRaw] = thrown(new InternalServerErrorException('boom'));
    const [clientFormatted, clientRaw] = thrown(new BadRequestException('x'), { code: 'X' });

    expect(formatConsoleError(serverFormatted, serverRaw, true).extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(formatConsoleError(clientFormatted, clientRaw, true).extensions?.code).toBe('BAD_USER_INPUT');
  });
});
