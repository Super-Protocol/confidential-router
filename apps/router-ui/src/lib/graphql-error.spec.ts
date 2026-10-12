import { CombinedGraphQLErrors, ServerError } from '@apollo/client';
import { describe, expect, it } from 'vitest';
import { errorMessageOf, fieldErrorsOf } from './graphql-error';

/** What Apollo throws for a GraphQL response that carried `errors`. */
function graphQLError(message: string, extensions: Record<string, unknown> = {}) {
  return new CombinedGraphQLErrors({ data: null, errors: [{ message, extensions }] });
}

/** What Apollo throws for a non-200: the status, and the body as text. */
function serverError(status: number, body: string) {
  return new ServerError(`Response not successful: Received status code ${status}`, {
    response: new Response(body, { status }),
    bodyText: body,
  });
}

describe('errorMessageOf', () => {
  it('quotes our own API, which writes its refusals for a user', () => {
    expect(errorMessageOf(graphQLError('Unknown model id(s): nope.'))).toBe('Unknown model id(s): nope.');
  });

  /*
   * SUP-295 item 2. Apollo's HTTP link throws on the status code before it looks
   * at the body, so a refusal the server made before executing the document —
   * which is answered with a 4xx — never arrives as a GraphQL error. Reading
   * only `CombinedGraphQLErrors` turned all of those into one sentence that
   * said nothing, which is what a tester saw and could not act on.
   */
  it('reads the GraphQL errors out of a non-200 response', () => {
    const error = serverError(400, JSON.stringify({ errors: [{ message: 'spendLimitMicros must be a number' }] }));

    expect(errorMessageOf(error)).toBe('spendLimitMicros must be a number');
  });

  it('names the status when the body is not a GraphQL response at all', () => {
    // A gateway's HTML error page: nothing to quote, and quoting it would put a
    // proxy's hostname in front of the user. The number is still worth having.
    expect(errorMessageOf(serverError(502, '<html>Bad Gateway</html>'))).toBe(
      'The request failed. Please try again. (The server answered 502.)',
    );
  });

  it('keeps the caller’s own wording for the failure it describes', () => {
    expect(errorMessageOf(serverError(503, ''), 'The evidence bundle could not be exported.')).toBe(
      'The evidence bundle could not be exported. (The server answered 503.)',
    );
  });

  it('replaces anything else, which can name internal hosts', () => {
    expect(errorMessageOf(new Error('connect ECONNREFUSED 10.0.0.4:3000'))).toBe(
      'The request failed. Please try again.',
    );
  });
});

describe('fieldErrorsOf', () => {
  it('reads the per-field messages the API attached', () => {
    const error = graphQLError('spendLimitMicros must match /^\\d{1,15}$/', {
      code: 'BAD_USER_INPUT',
      fields: { spendLimitMicros: 'spendLimitMicros must match /^\\d{1,15}$/' },
    });

    expect(fieldErrorsOf(error)).toEqual({ spendLimitMicros: 'spendLimitMicros must match /^\\d{1,15}$/' });
  });

  it('reads them out of a non-200 body too', () => {
    const error = serverError(
      400,
      JSON.stringify({ errors: [{ message: 'bad', extensions: { fields: { name: 'name must be a string' } } }] }),
    );

    expect(fieldErrorsOf(error)).toEqual({ name: 'name must be a string' });
  });

  it('is empty when the failure was not about a field', () => {
    expect(fieldErrorsOf(graphQLError('Authentication is required.'))).toEqual({});
    expect(fieldErrorsOf(new Error('network down'))).toEqual({});
    // A `fields` that is not a map of strings is not a map this form can use.
    expect(fieldErrorsOf(graphQLError('x', { fields: 'nope' }))).toEqual({});
    expect(fieldErrorsOf(graphQLError('x', { fields: { a: 1 } }))).toEqual({});
  });
});
