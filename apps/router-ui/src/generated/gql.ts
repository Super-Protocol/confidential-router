/* eslint-disable */
import * as types from './graphql';
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';

/**
 * Map of all GraphQL operations in the project.
 *
 * This map has several performance disadvantages:
 * 1. It is not tree-shakeable, so it will include all operations in the project.
 * 2. It is not minifiable, so the string of a GraphQL query will be multiple times inside the bundle.
 * 3. It does not support dead code elimination, so it will add unused operations.
 *
 * Therefore it is highly recommended to use the babel or swc plugin for production.
 * Learn more about it here: https://the-guild.dev/graphql/codegen/plugins/presets/preset-client#reducing-bundle-size
 */
type Documents = {
    "\n  query GatekeeperRelease {\n    gatekeeperRelease {\n      version\n      notesUrl\n      checksumsUrl\n      publishedAt\n      fetchedAt\n      stale\n      downloads {\n        os\n        arch\n        name\n        url\n        sizeBytes\n      }\n    }\n  }\n": typeof types.GatekeeperReleaseDocument,
    "\n  fragment ApiKeyFields on ApiKey {\n    id\n    name\n    prefix\n    modelScope\n    createdAt\n    expiresAt\n    lastUsedAt\n    revokedAt\n    spendLimitMicros\n    spentTotalMicros\n    requestsPerMinute\n    tokensPerMinute\n  }\n": typeof types.ApiKeyFieldsFragmentDoc,
    "\n  query ApiKeys($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      ...ApiKeyFields\n    }\n    models {\n      id\n      name\n    }\n  }\n": typeof types.ApiKeysDocument,
    "\n  mutation CreateApiKey($input: CreateApiKeyInput!) {\n    createApiKey(input: $input) {\n      secret\n      key {\n        ...ApiKeyFields\n      }\n    }\n  }\n": typeof types.CreateApiKeyDocument,
    "\n  mutation UpdateApiKey($id: ID!, $input: UpdateApiKeyInput!) {\n    updateApiKey(id: $id, input: $input) {\n      ...ApiKeyFields\n    }\n  }\n": typeof types.UpdateApiKeyDocument,
    "\n  mutation RevokeApiKey($id: ID!) {\n    revokeApiKey(id: $id) {\n      ...ApiKeyFields\n    }\n  }\n": typeof types.RevokeApiKeyDocument,
    "\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n": typeof types.SessionDocument,
};
const documents: Documents = {
    "\n  query GatekeeperRelease {\n    gatekeeperRelease {\n      version\n      notesUrl\n      checksumsUrl\n      publishedAt\n      fetchedAt\n      stale\n      downloads {\n        os\n        arch\n        name\n        url\n        sizeBytes\n      }\n    }\n  }\n": types.GatekeeperReleaseDocument,
    "\n  fragment ApiKeyFields on ApiKey {\n    id\n    name\n    prefix\n    modelScope\n    createdAt\n    expiresAt\n    lastUsedAt\n    revokedAt\n    spendLimitMicros\n    spentTotalMicros\n    requestsPerMinute\n    tokensPerMinute\n  }\n": types.ApiKeyFieldsFragmentDoc,
    "\n  query ApiKeys($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      ...ApiKeyFields\n    }\n    models {\n      id\n      name\n    }\n  }\n": types.ApiKeysDocument,
    "\n  mutation CreateApiKey($input: CreateApiKeyInput!) {\n    createApiKey(input: $input) {\n      secret\n      key {\n        ...ApiKeyFields\n      }\n    }\n  }\n": types.CreateApiKeyDocument,
    "\n  mutation UpdateApiKey($id: ID!, $input: UpdateApiKeyInput!) {\n    updateApiKey(id: $id, input: $input) {\n      ...ApiKeyFields\n    }\n  }\n": types.UpdateApiKeyDocument,
    "\n  mutation RevokeApiKey($id: ID!) {\n    revokeApiKey(id: $id) {\n      ...ApiKeyFields\n    }\n  }\n": types.RevokeApiKeyDocument,
    "\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n": types.SessionDocument,
};

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 *
 *
 * @example
 * ```ts
 * const query = graphql(`query GetUser($id: ID!) { user(id: $id) { name } }`);
 * ```
 *
 * The query argument is unknown!
 * Please regenerate the types.
 */
export function graphql(source: string): unknown;

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query GatekeeperRelease {\n    gatekeeperRelease {\n      version\n      notesUrl\n      checksumsUrl\n      publishedAt\n      fetchedAt\n      stale\n      downloads {\n        os\n        arch\n        name\n        url\n        sizeBytes\n      }\n    }\n  }\n"): (typeof documents)["\n  query GatekeeperRelease {\n    gatekeeperRelease {\n      version\n      notesUrl\n      checksumsUrl\n      publishedAt\n      fetchedAt\n      stale\n      downloads {\n        os\n        arch\n        name\n        url\n        sizeBytes\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment ApiKeyFields on ApiKey {\n    id\n    name\n    prefix\n    modelScope\n    createdAt\n    expiresAt\n    lastUsedAt\n    revokedAt\n    spendLimitMicros\n    spentTotalMicros\n    requestsPerMinute\n    tokensPerMinute\n  }\n"): (typeof documents)["\n  fragment ApiKeyFields on ApiKey {\n    id\n    name\n    prefix\n    modelScope\n    createdAt\n    expiresAt\n    lastUsedAt\n    revokedAt\n    spendLimitMicros\n    spentTotalMicros\n    requestsPerMinute\n    tokensPerMinute\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ApiKeys($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      ...ApiKeyFields\n    }\n    models {\n      id\n      name\n    }\n  }\n"): (typeof documents)["\n  query ApiKeys($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      ...ApiKeyFields\n    }\n    models {\n      id\n      name\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CreateApiKey($input: CreateApiKeyInput!) {\n    createApiKey(input: $input) {\n      secret\n      key {\n        ...ApiKeyFields\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation CreateApiKey($input: CreateApiKeyInput!) {\n    createApiKey(input: $input) {\n      secret\n      key {\n        ...ApiKeyFields\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation UpdateApiKey($id: ID!, $input: UpdateApiKeyInput!) {\n    updateApiKey(id: $id, input: $input) {\n      ...ApiKeyFields\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateApiKey($id: ID!, $input: UpdateApiKeyInput!) {\n    updateApiKey(id: $id, input: $input) {\n      ...ApiKeyFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation RevokeApiKey($id: ID!) {\n    revokeApiKey(id: $id) {\n      ...ApiKeyFields\n    }\n  }\n"): (typeof documents)["\n  mutation RevokeApiKey($id: ID!) {\n    revokeApiKey(id: $id) {\n      ...ApiKeyFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n"): (typeof documents)["\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n"];

export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> = TDocumentNode extends DocumentNode<  infer TType,  any>  ? TType  : never;