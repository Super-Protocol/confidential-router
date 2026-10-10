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
        redemptionRate
        activated
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
        }
      }
    }
  }
`);

export const ADMIN_SIGN_UPS_QUERY = graphql(`
  query AdminSignUps($origin: SignUpOrigin, $offset: Int!, $limit: Int!) {
    adminSignUps(origin: $origin, offset: $offset, limit: $limit) {
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
      }
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
