import { graphql } from '../../generated';

export const USER_PREFERENCES_FIELDS = graphql(`
  fragment UserPreferencesFields on UserPreferences {
    archiveEvidence
    evidenceRetentionDays
    notifyOnMeasurementChange
    desktopNotifications
    emailReceipts
  }
`);

/**
 * The whole screen is `me`, which the shell has already asked for: the
 * preferences hang off the same normalised entity, so this adds a field to a
 * cached user rather than a second source of truth.
 */
export const PREFERENCES_QUERY = graphql(`
  query Preferences {
    me {
      id
      email
      createdAt
      preferences {
        ...UserPreferencesFields
      }
    }
  }
`);

export const UPDATE_PREFERENCES = graphql(`
  mutation UpdatePreferences($input: UpdatePreferencesInput!) {
    updatePreferences(input: $input) {
      ...UserPreferencesFields
    }
  }
`);

export const EXPORT_EVIDENCE = graphql(`
  mutation ExportEvidence($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {
    exportEvidence(workspaceId: $workspaceId, from: $from, to: $to) {
      url
      expiresAt
    }
  }
`);
