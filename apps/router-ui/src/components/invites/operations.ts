import { graphql } from '../../generated';

/**
 * What became of the code the sign-up carried.
 *
 * The code is passed back because nothing persists a *refusal*: the redemption
 * path writes a row when it succeeds and deliberately nothing when it does not,
 * so the browser that presented the code is the only thing that still knows which
 * one it was. The answer is a grant, a reason, or neither (SUP-145).
 */
export const INVITE_GRANT_STATUS_QUERY = graphql(`
  query InviteGrantStatus($code: String) {
    inviteGrantStatus(code: $code) {
      reason
      grant {
        creditTransactionId
        grantMicros
        campaign
        redeemedAt
      }
    }
  }
`);
