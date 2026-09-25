import type { MockLink } from '@apollo/client/testing';
import { FEEDBACK_OFFER } from './operations';

export interface FeedbackOfferOverrides {
  /**
   * How many times this response may be used.
   *
   * Unbounded by default, because `cache-and-network` re-issues the query on
   * every remount. A test that wants the *next* answer to differ — the grant
   * landing while the viewer waits — sets it to 1 and puts the second answer
   * after it.
   */
  times?: number;
  eligible?: boolean;
  reason?: string | null;
  grantMicros?: string;
  formUrl?: string | null;
  granted?: { creditTransactionId: string; grantMicros: string; appliedAt: string } | null;
}

/**
 * The offer a viewer who is *not* being asked for feedback gets, which is most
 * of them.
 *
 * Every screen inside the shell issues this query, so it belongs with the
 * session mock rather than in each suite: a test about the ledger that had to
 * remember to stub the feedback offer would be a test about the wrong thing.
 */
export function feedbackOfferMock(overrides: FeedbackOfferOverrides = {}): MockLink.MockedResponse {
  const granted = overrides.granted ?? null;
  return {
    request: { query: FEEDBACK_OFFER },
    result: {
      data: {
        feedbackOffer: {
          __typename: 'FeedbackOffer',
          eligible: overrides.eligible ?? false,
          reason: overrides.reason ?? (overrides.eligible ? null : 'BALANCE_HEALTHY'),
          grantMicros: overrides.grantMicros ?? '100000000',
          formUrl: overrides.formUrl ?? (overrides.eligible ? 'https://form.example/to/aBcDeF?t=token' : null),
          granted: granted ? { __typename: 'FeedbackGrant', ...granted } : null,
        },
      },
    },
    maxUsageCount: overrides.times ?? Number.POSITIVE_INFINITY,
  };
}
