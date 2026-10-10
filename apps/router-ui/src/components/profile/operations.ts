import { graphql } from '../../generated';

/**
 * The whole screen in one round trip: who the viewer is, what the workspace
 * spent over the last week, which models it went on, and the days a generation
 * came back with published evidence.
 */
export const PROFILE_QUERY = graphql(`
  query Profile($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $heatmapDays: Int!) {
    me {
      id
      name
      email
      avatarUrl
      createdAt
    }
    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {
      bucket
      spendMicros
      requests
      promptTokens
      completionTokens
    }
    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {
      modelId
      name
      spendMicros
      requests
    }
    signedResponseDays(workspaceId: $workspaceId, days: $heatmapDays)
  }
`);

/**
 * Returns the whole `User`, not just the name: `me` is one normalised cache
 * entry, and a mutation that wrote back fewer fields than the shell reads would
 * blank the workspace switcher.
 */
export const UPDATE_PROFILE = graphql(`
  mutation UpdateProfile($input: UpdateProfileInput!) {
    updateProfile(input: $input) {
      id
      name
      email
      avatarUrl
      createdAt
    }
  }
`);
