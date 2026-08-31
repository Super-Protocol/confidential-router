/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
export type CreateApiKeyInput = {
  expiresAt?: string | null | undefined;
  /** Restrict the key to these model ids. Omit for all. */
  modelIds?: Array<string> | null | undefined;
  name: string;
  requestsPerMinute?: number | null | undefined;
  spendLimitMicros?: string | null | undefined;
  tokensPerMinute?: number | null | undefined;
  workspaceId: string | number;
};

export type GatekeeperArch =
  | 'AMD64'
  | 'ARM64';

export type GatekeeperOs =
  | 'LINUX'
  | 'MACOS'
  | 'WINDOWS';

export type UpdateApiKeyInput = {
  expiresAt?: string | null | undefined;
  /** Replaces the scope. An empty list clears it. */
  modelIds?: Array<string> | null | undefined;
  name?: string | null | undefined;
  requestsPerMinute?: number | null | undefined;
  spendLimitMicros?: string | null | undefined;
  tokensPerMinute?: number | null | undefined;
};

/** An owner may spend the workspace’s credits; a member may only use them. */
export type WorkspaceRole =
  | 'MEMBER'
  | 'OWNER';

export type GatekeeperReleaseQueryVariables = Exact<{ [key: string]: never; }>;


export type GatekeeperReleaseQuery = { gatekeeperRelease: { version: string, notesUrl: string, checksumsUrl: string | null, publishedAt: string | null, fetchedAt: string, stale: boolean, downloads: Array<{ os: GatekeeperOs, arch: GatekeeperArch, name: string, url: string, sizeBytes: number }> } | null };

export type ApiKeyFieldsFragment = { id: string, name: string, prefix: string, modelScope: Array<string> | null, createdAt: string, expiresAt: string | null, lastUsedAt: string | null, revokedAt: string | null, spendLimitMicros: string | null, spentTotalMicros: string, requestsPerMinute: number | null, tokensPerMinute: number | null };

export type ApiKeysQueryVariables = Exact<{
  workspaceId: string | number;
}>;


export type ApiKeysQuery = { apiKeys: Array<{ id: string, name: string, prefix: string, modelScope: Array<string> | null, createdAt: string, expiresAt: string | null, lastUsedAt: string | null, revokedAt: string | null, spendLimitMicros: string | null, spentTotalMicros: string, requestsPerMinute: number | null, tokensPerMinute: number | null }>, models: Array<{ id: string, name: string }> };

export type CreateApiKeyMutationVariables = Exact<{
  input: CreateApiKeyInput;
}>;


export type CreateApiKeyMutation = { createApiKey: { secret: string, key: { id: string, name: string, prefix: string, modelScope: Array<string> | null, createdAt: string, expiresAt: string | null, lastUsedAt: string | null, revokedAt: string | null, spendLimitMicros: string | null, spentTotalMicros: string, requestsPerMinute: number | null, tokensPerMinute: number | null } } };

export type UpdateApiKeyMutationVariables = Exact<{
  id: string | number;
  input: UpdateApiKeyInput;
}>;


export type UpdateApiKeyMutation = { updateApiKey: { id: string, name: string, prefix: string, modelScope: Array<string> | null, createdAt: string, expiresAt: string | null, lastUsedAt: string | null, revokedAt: string | null, spendLimitMicros: string | null, spentTotalMicros: string, requestsPerMinute: number | null, tokensPerMinute: number | null } };

export type RevokeApiKeyMutationVariables = Exact<{
  id: string | number;
}>;


export type RevokeApiKeyMutation = { revokeApiKey: { id: string, name: string, prefix: string, modelScope: Array<string> | null, createdAt: string, expiresAt: string | null, lastUsedAt: string | null, revokedAt: string | null, spendLimitMicros: string | null, spentTotalMicros: string, requestsPerMinute: number | null, tokensPerMinute: number | null } };

export type SessionQueryVariables = Exact<{ [key: string]: never; }>;


export type SessionQuery = { me: { id: string, email: string, name: string | null, avatarUrl: string | null, workspaces: Array<{ id: string, name: string, slug: string, role: WorkspaceRole, balanceMicros: string }> } };

export const ApiKeyFieldsFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ApiKeyFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ApiKey"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"prefix"}},{"kind":"Field","name":{"kind":"Name","value":"modelScope"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastUsedAt"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}},{"kind":"Field","name":{"kind":"Name","value":"spendLimitMicros"}},{"kind":"Field","name":{"kind":"Name","value":"spentTotalMicros"}},{"kind":"Field","name":{"kind":"Name","value":"requestsPerMinute"}},{"kind":"Field","name":{"kind":"Name","value":"tokensPerMinute"}}]}}]} as unknown as DocumentNode<ApiKeyFieldsFragment, unknown>;
export const GatekeeperReleaseDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GatekeeperRelease"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"gatekeeperRelease"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"notesUrl"}},{"kind":"Field","name":{"kind":"Name","value":"checksumsUrl"}},{"kind":"Field","name":{"kind":"Name","value":"publishedAt"}},{"kind":"Field","name":{"kind":"Name","value":"fetchedAt"}},{"kind":"Field","name":{"kind":"Name","value":"stale"}},{"kind":"Field","name":{"kind":"Name","value":"downloads"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"os"}},{"kind":"Field","name":{"kind":"Name","value":"arch"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"sizeBytes"}}]}}]}}]}}]} as unknown as DocumentNode<GatekeeperReleaseQuery, GatekeeperReleaseQueryVariables>;
export const ApiKeysDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ApiKeys"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"apiKeys"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"workspaceId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ApiKeyFields"}}]}},{"kind":"Field","name":{"kind":"Name","value":"models"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ApiKeyFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ApiKey"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"prefix"}},{"kind":"Field","name":{"kind":"Name","value":"modelScope"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastUsedAt"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}},{"kind":"Field","name":{"kind":"Name","value":"spendLimitMicros"}},{"kind":"Field","name":{"kind":"Name","value":"spentTotalMicros"}},{"kind":"Field","name":{"kind":"Name","value":"requestsPerMinute"}},{"kind":"Field","name":{"kind":"Name","value":"tokensPerMinute"}}]}}]} as unknown as DocumentNode<ApiKeysQuery, ApiKeysQueryVariables>;
export const CreateApiKeyDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateApiKey"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateApiKeyInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createApiKey"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"secret"}},{"kind":"Field","name":{"kind":"Name","value":"key"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ApiKeyFields"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ApiKeyFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ApiKey"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"prefix"}},{"kind":"Field","name":{"kind":"Name","value":"modelScope"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastUsedAt"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}},{"kind":"Field","name":{"kind":"Name","value":"spendLimitMicros"}},{"kind":"Field","name":{"kind":"Name","value":"spentTotalMicros"}},{"kind":"Field","name":{"kind":"Name","value":"requestsPerMinute"}},{"kind":"Field","name":{"kind":"Name","value":"tokensPerMinute"}}]}}]} as unknown as DocumentNode<CreateApiKeyMutation, CreateApiKeyMutationVariables>;
export const UpdateApiKeyDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateApiKey"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateApiKeyInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateApiKey"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ApiKeyFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ApiKeyFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ApiKey"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"prefix"}},{"kind":"Field","name":{"kind":"Name","value":"modelScope"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastUsedAt"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}},{"kind":"Field","name":{"kind":"Name","value":"spendLimitMicros"}},{"kind":"Field","name":{"kind":"Name","value":"spentTotalMicros"}},{"kind":"Field","name":{"kind":"Name","value":"requestsPerMinute"}},{"kind":"Field","name":{"kind":"Name","value":"tokensPerMinute"}}]}}]} as unknown as DocumentNode<UpdateApiKeyMutation, UpdateApiKeyMutationVariables>;
export const RevokeApiKeyDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RevokeApiKey"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"revokeApiKey"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ApiKeyFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ApiKeyFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"ApiKey"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"prefix"}},{"kind":"Field","name":{"kind":"Name","value":"modelScope"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastUsedAt"}},{"kind":"Field","name":{"kind":"Name","value":"revokedAt"}},{"kind":"Field","name":{"kind":"Name","value":"spendLimitMicros"}},{"kind":"Field","name":{"kind":"Name","value":"spentTotalMicros"}},{"kind":"Field","name":{"kind":"Name","value":"requestsPerMinute"}},{"kind":"Field","name":{"kind":"Name","value":"tokensPerMinute"}}]}}]} as unknown as DocumentNode<RevokeApiKeyMutation, RevokeApiKeyMutationVariables>;
export const SessionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Session"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"me"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"workspaces"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"balanceMicros"}}]}}]}}]}}]} as unknown as DocumentNode<SessionQuery, SessionQueryVariables>;