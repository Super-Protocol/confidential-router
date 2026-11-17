import type { MockLink } from '@apollo/client/testing';
import type { SignInMailStateName } from '../../generated/graphql';
import { SIGN_IN_MAIL_STATE_QUERY } from './operations';

/**
 * What the router says about the address the code screen just mailed.
 *
 * `UNKNOWN` by default, because that is the answer for every address nothing
 * has gone wrong with — which is almost all of them, and all of them in a test
 * that is about something else. It is appended to `renderWithApollo` for the
 * same reason `feedbackOfferMock()` is appended to `renderWithSession`: every
 * mount of `EmailCodeStep` issues this query, and a sign-in test that had to
 * remember to stub it would be a test about the wrong thing.
 *
 * `variables` is a matcher rather than a value: the address is whatever the
 * test typed, and a default nobody passes arguments to cannot know it.
 */
export function signInMailStateMock(state: SignInMailStateName = 'UNKNOWN'): MockLink.MockedResponse {
  return {
    request: { query: SIGN_IN_MAIL_STATE_QUERY, variables: () => true },
    result: { data: { signInMailState: { __typename: 'SignInMailState', state } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}
