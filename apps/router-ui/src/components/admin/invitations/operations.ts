import { graphql } from '../../../generated';

/*
 * The Invitations section's operations (SUP-268). Every one of them is behind
 * `auth.adminEmails` on the API; the screen only asks them for an administrator.
 */

export const INVITE_STATISTICS_QUERY = graphql(`
  query InviteStatistics($days: Int!) {
    inviteStatistics(days: $days) {
      totals {
        issued
        redeemed
        carried
        withdrawn
        redemptionRate
        grantedMicros
        signUps
      }
      daily {
        date
        codesIssued
        codesRedeemed
        signUpsInvited
        signUpsBootstrap
        signUpsOpen
      }
      campaigns {
        campaign
        issued
        redeemed
        carried
        redemptionRate
        activated
        codeGrantMicrosMin
        codeGrantMicrosMax
        grantedMicros
      }
    }
  }
`);

export const ADMIN_INVITE_CODES_QUERY = graphql(`
  query AdminInviteCodes($campaign: String, $status: InviteCodeStatus, $offset: Int!, $limit: Int!) {
    adminInviteCodes(campaign: $campaign, status: $status, offset: $offset, limit: $limit) {
      totalCount
      nodes {
        id
        code
        url
        campaign
        grantMicros
        maxRedemptions
        redemptionCount
        status
        createdAt
        expiresAt
        withdrawnAt
        note
        issuedByEmail
        redeemers {
          userId
          email
          redeemedAt
          carried
        }
      }
    }
  }
`);

export const ADMIN_SIGN_UPS_QUERY = graphql(`
  query AdminSignUps($origin: SignUpOrigin, $holdsLiveApiKey: Boolean, $offset: Int!, $limit: Int!) {
    adminSignUps(origin: $origin, holdsLiveApiKey: $holdsLiveApiKey, offset: $offset, limit: $limit) {
      totalCount
      nodes {
        userId
        email
        createdAt
        origin
        inviteCodeId
        inviteCode
        campaign
        redeemedAt
        apiKeys {
          total
          live
          lastUsedAt
        }
        workspaceId
        balanceMicros
      }
    }
  }
`);

/**
 * The deployment's credential totals (SUP-454) — what a key-affecting change
 * would void, which no per-page sum can give: a key in a shared workspace
 * belongs to every member of it, and `liveKeysWithoutAccount` is held by no
 * account the deployment can name.
 */
export const ADMIN_API_KEY_POPULATION_QUERY = graphql(`
  query AdminApiKeyPopulation {
    adminApiKeyPopulation {
      keys
      liveKeys
      accountsHoldingLiveKey
      liveKeysWithoutAccount
    }
  }
`);

export const GRANT_CREDIT = graphql(`
  mutation GrantCredit($input: GrantCreditInput!) {
    grantCredit(input: $input) {
      creditTransactionId
      workspaceId
      accountEmail
      kind
      amountMicros
      balanceMicros
      note
      replayed
    }
  }
`);

export const ISSUE_INVITE_CODES = graphql(`
  mutation IssueInviteCodes($input: IssueInviteCodesInput!) {
    issueInviteCodes(input: $input) {
      campaign
      grantMicros
      expiresAt
      codes {
        id
        code
        url
      }
    }
  }
`);

export const WITHDRAW_INVITE_CODE = graphql(`
  mutation WithdrawInviteCode($id: ID!) {
    withdrawInviteCode(id: $id) {
      target
      matched
      withdrawn
      alreadyWithdrawn
      spent
    }
  }
`);

export const MAIL_DELIVERY_QUERY = graphql(`
  query MailDelivery {
    mailDelivery {
      provider
      state
      reason
      since
      inviteOnly
      withheld {
        noInvitation
        rateLimited
        unusedCodeType
        lastWithheldAt
      }
    }
  }
`);
