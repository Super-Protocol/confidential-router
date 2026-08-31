import { graphql } from '../../generated';

/**
 * Everything the screen renders for one key. The four operations all return an
 * `ApiKey`, and a mutation that came back with fewer fields than the list needs
 * would silently write a hole into the Apollo cache.
 */
export const API_KEY_FIELDS = graphql(`
  fragment ApiKeyFields on ApiKey {
    id
    name
    prefix
    modelScope
    createdAt
    expiresAt
    lastUsedAt
    revokedAt
    spendLimitMicros
    spentTotalMicros
    requestsPerMinute
    tokensPerMinute
  }
`);

/**
 * The catalogue rides along because the scope column and the scope picker both
 * turn model ids into names, and a second round trip for a list that is public
 * and short would only make the screen paint twice.
 */
export const API_KEYS_QUERY = graphql(`
  query ApiKeys($workspaceId: ID!) {
    apiKeys(workspaceId: $workspaceId) {
      ...ApiKeyFields
    }
    models {
      id
      name
    }
  }
`);

export const CREATE_API_KEY = graphql(`
  mutation CreateApiKey($input: CreateApiKeyInput!) {
    createApiKey(input: $input) {
      secret
      key {
        ...ApiKeyFields
      }
    }
  }
`);

export const UPDATE_API_KEY = graphql(`
  mutation UpdateApiKey($id: ID!, $input: UpdateApiKeyInput!) {
    updateApiKey(id: $id, input: $input) {
      ...ApiKeyFields
    }
  }
`);

export const REVOKE_API_KEY = graphql(`
  mutation RevokeApiKey($id: ID!) {
    revokeApiKey(id: $id) {
      ...ApiKeyFields
    }
  }
`);
