import { graphql } from '../../generated';

/**
 * One page of the ledger. It lives here because the cache update after
 * `setAutoTopUp` has to name exactly the variables `CREDITS_QUERY` was asked
 * with, and a second copy of the number would silently stop matching.
 */
export const CREDITS_PAGE_SIZE = 20;

/**
 * Everything the screen header and the auto top-up card read.
 *
 * `setAutoTopUp` returns the same `CreditBalance`, so the mutation writes the
 * whole shape back into the cache and the header cannot disagree with the card
 * it sits above.
 */
export const CREDIT_BALANCE_FIELDS = graphql(`
  fragment CreditBalanceFields on CreditBalance {
    workspaceId
    balanceMicros
    spendable
    minTopUpMicros
    autoTopUp {
      enabled
      available
      thresholdMicros
      amountMicros
      lastChargedAt
    }
  }
`);

/**
 * The whole screen in one round trip. `after` is null on the first page and
 * carries the cursor on "Load more" — the balance rides along, which is what a
 * viewer paging through the ledger wants anyway.
 */
export const CREDITS_QUERY = graphql(`
  query Credits($workspaceId: ID!, $first: Int!, $after: String) {
    creditBalance(workspaceId: $workspaceId) {
      ...CreditBalanceFields
    }
    creditTransactions(workspaceId: $workspaceId, first: $first, after: $after) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          createdAt
          kind
          amountMicros
          reference
          description
        }
      }
    }
  }
`);

export const CREATE_CHECKOUT = graphql(`
  mutation CreateCheckout($input: CreateCheckoutInput!) {
    createCheckout(input: $input) {
      url
      ref
    }
  }
`);

export const SET_AUTO_TOP_UP = graphql(`
  mutation SetAutoTopUp($input: SetAutoTopUpInput!) {
    setAutoTopUp(input: $input) {
      ...CreditBalanceFields
    }
  }
`);
