import type { MockLink } from '@apollo/client/testing';
import { TEST_VIEWER, TEST_WORKSPACES } from '../test-utils';
import { SESSION_QUERY } from './session/session-provider';

/**
 * `sessionMock` with `__typename` on every entity.
 *
 * The shared fixture omits it, which is harmless for a screen that only reads
 * the session. It is not harmless for the account screens: they ask for other
 * fields of the same `me`, and without a `__typename` Apollo cannot normalise
 * the two reads onto one `User` — each response replaces the other's fields and
 * the screens refetch in a loop. The real API always sends `__typename`.
 */
export function typedSessionMock(workspaces = TEST_WORKSPACES): MockLink.MockedResponse {
  return {
    request: { query: SESSION_QUERY },
    result: {
      data: {
        me: {
          __typename: 'User',
          ...TEST_VIEWER,
          workspaces: workspaces.map((workspace) => ({ __typename: 'Workspace', ...workspace })),
        },
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}
