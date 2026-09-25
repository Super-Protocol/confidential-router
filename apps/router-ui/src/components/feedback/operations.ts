import { graphql } from '../../generated';

/**
 * Whether to ask this viewer for feedback, and the link to ask with.
 *
 * Eligibility is the server's answer and never the browser's arithmetic: the
 * console has the balance in hand and could guess, but a grant decided in a tab
 * is a grant anyone can decide (`feedback-eligibility.service.ts`).
 *
 * `formUrl` carries a token that expires in minutes, which is why this query is
 * re-read rather than cached for the life of the page.
 */
export const FEEDBACK_OFFER = graphql(`
  query FeedbackOffer {
    feedbackOffer {
      eligible
      reason
      grantMicros
      formUrl
      granted {
        creditTransactionId
        grantMicros
        appliedAt
      }
    }
  }
`);
