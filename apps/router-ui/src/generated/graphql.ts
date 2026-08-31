/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
/** Granularity of an activity series. Buckets start on UTC boundaries. */
export type Bucket =
  | 'DAY'
  | 'HOUR';

export type GenerationFilter = {
  apiKeyIds?: Array<string | number> | null | undefined;
  from?: string | null | undefined;
  modelIds?: Array<string | number> | null | undefined;
  statuses?: Array<GenerationStatus> | null | undefined;
  to?: string | null | undefined;
};

export type GenerationSort = {
  direction?: SortDirection;
  field?: GenerationSortField;
};

export type GenerationSortField =
  | 'COST'
  | 'CREATED_AT'
  | 'LATENCY'
  | 'TOTAL_TOKENS';

export type GenerationStatus =
  | 'ABORTED'
  | 'ERROR'
  | 'OK';

export type SortDirection =
  | 'ASC'
  | 'DESC';

/** An owner may spend the workspace’s credits; a member may only use them. */
export type WorkspaceRole =
  | 'MEMBER'
  | 'OWNER';

export type ActivityQueryVariables = Exact<{
  workspaceId: string | number;
  from: string;
  to: string;
  bucket: Bucket;
}>;


export type ActivityQuery = { activitySummary: { spendMicros: string, requests: number, promptTokens: number, completionTokens: number, coveredRequests: number, evidenceCoverage: number, avgTimeToFirstTokenMs: number | null, avgTokensPerSecond: number | null }, activitySeries: Array<{ bucket: string, spendMicros: string, requests: number, promptTokens: number, completionTokens: number, evidenceCoverage: number }>, topKeys: Array<{ apiKeyId: string | null, name: string, prefix: string | null, requests: number, promptTokens: number, completionTokens: number, spendMicros: string }> };

export type ActivityUsageByModelQueryVariables = Exact<{
  workspaceId: string | number;
  from: string;
  to: string;
  limit?: number | null | undefined;
}>;


export type ActivityUsageByModelQuery = { usageByModel: Array<{ modelId: string, name: string, requests: number, promptTokens: number, completionTokens: number, spendMicros: string, evidenceCoverage: number }> };

export type GenerationLogQueryVariables = Exact<{
  workspaceId: string | number;
  filter?: GenerationFilter | null | undefined;
  sort?: GenerationSort | null | undefined;
  first: number;
  after?: string | null | undefined;
}>;


export type GenerationLogQuery = { generations: { totalCount: number, pageInfo: { hasNextPage: boolean, endCursor: string | null }, edges: Array<{ cursor: string, node: { id: string, createdAt: string, modelId: string, modelName: string, apiKeyId: string | null, apiKeyName: string | null, promptTokens: number, completionTokens: number, costMicros: string, latencyMs: number, timeToFirstTokenMs: number | null, tokensPerSecond: number | null, status: GenerationStatus, errorCode: string | null } }> } };

export type LogFilterOptionsQueryVariables = Exact<{
  workspaceId: string | number;
}>;


export type LogFilterOptionsQuery = { models: Array<{ id: string, name: string }>, apiKeys: Array<{ id: string, name: string, prefix: string }> };

export type SessionQueryVariables = Exact<{ [key: string]: never; }>;


export type SessionQuery = { me: { id: string, email: string, name: string | null, avatarUrl: string | null, workspaces: Array<{ id: string, name: string, slug: string, role: WorkspaceRole, balanceMicros: string }> } };


export const ActivityDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Activity"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"from"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"to"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"bucket"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Bucket"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"activitySummary"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"workspaceId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}}},{"kind":"Argument","name":{"kind":"Name","value":"from"},"value":{"kind":"Variable","name":{"kind":"Name","value":"from"}}},{"kind":"Argument","name":{"kind":"Name","value":"to"},"value":{"kind":"Variable","name":{"kind":"Name","value":"to"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"spendMicros"}},{"kind":"Field","name":{"kind":"Name","value":"requests"}},{"kind":"Field","name":{"kind":"Name","value":"promptTokens"}},{"kind":"Field","name":{"kind":"Name","value":"completionTokens"}},{"kind":"Field","name":{"kind":"Name","value":"coveredRequests"}},{"kind":"Field","name":{"kind":"Name","value":"evidenceCoverage"}},{"kind":"Field","name":{"kind":"Name","value":"avgTimeToFirstTokenMs"}},{"kind":"Field","name":{"kind":"Name","value":"avgTokensPerSecond"}}]}},{"kind":"Field","name":{"kind":"Name","value":"activitySeries"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"workspaceId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}}},{"kind":"Argument","name":{"kind":"Name","value":"from"},"value":{"kind":"Variable","name":{"kind":"Name","value":"from"}}},{"kind":"Argument","name":{"kind":"Name","value":"to"},"value":{"kind":"Variable","name":{"kind":"Name","value":"to"}}},{"kind":"Argument","name":{"kind":"Name","value":"bucket"},"value":{"kind":"Variable","name":{"kind":"Name","value":"bucket"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"bucket"}},{"kind":"Field","name":{"kind":"Name","value":"spendMicros"}},{"kind":"Field","name":{"kind":"Name","value":"requests"}},{"kind":"Field","name":{"kind":"Name","value":"promptTokens"}},{"kind":"Field","name":{"kind":"Name","value":"completionTokens"}},{"kind":"Field","name":{"kind":"Name","value":"evidenceCoverage"}}]}},{"kind":"Field","name":{"kind":"Name","value":"topKeys"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"workspaceId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}}},{"kind":"Argument","name":{"kind":"Name","value":"from"},"value":{"kind":"Variable","name":{"kind":"Name","value":"from"}}},{"kind":"Argument","name":{"kind":"Name","value":"to"},"value":{"kind":"Variable","name":{"kind":"Name","value":"to"}}},{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"IntValue","value":"5"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"apiKeyId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"prefix"}},{"kind":"Field","name":{"kind":"Name","value":"requests"}},{"kind":"Field","name":{"kind":"Name","value":"promptTokens"}},{"kind":"Field","name":{"kind":"Name","value":"completionTokens"}},{"kind":"Field","name":{"kind":"Name","value":"spendMicros"}}]}}]}}]} as unknown as DocumentNode<ActivityQuery, ActivityQueryVariables>;
export const ActivityUsageByModelDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ActivityUsageByModel"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"from"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"to"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"usageByModel"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"workspaceId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}}},{"kind":"Argument","name":{"kind":"Name","value":"from"},"value":{"kind":"Variable","name":{"kind":"Name","value":"from"}}},{"kind":"Argument","name":{"kind":"Name","value":"to"},"value":{"kind":"Variable","name":{"kind":"Name","value":"to"}}},{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"modelId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"requests"}},{"kind":"Field","name":{"kind":"Name","value":"promptTokens"}},{"kind":"Field","name":{"kind":"Name","value":"completionTokens"}},{"kind":"Field","name":{"kind":"Name","value":"spendMicros"}},{"kind":"Field","name":{"kind":"Name","value":"evidenceCoverage"}}]}}]}}]} as unknown as DocumentNode<ActivityUsageByModelQuery, ActivityUsageByModelQueryVariables>;
export const GenerationLogDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GenerationLog"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"filter"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"GenerationFilter"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"sort"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"GenerationSort"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"generations"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"workspaceId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}}},{"kind":"Argument","name":{"kind":"Name","value":"filter"},"value":{"kind":"Variable","name":{"kind":"Name","value":"filter"}}},{"kind":"Argument","name":{"kind":"Name","value":"sort"},"value":{"kind":"Variable","name":{"kind":"Name","value":"sort"}}},{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalCount"}},{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cursor"}},{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"modelId"}},{"kind":"Field","name":{"kind":"Name","value":"modelName"}},{"kind":"Field","name":{"kind":"Name","value":"apiKeyId"}},{"kind":"Field","name":{"kind":"Name","value":"apiKeyName"}},{"kind":"Field","name":{"kind":"Name","value":"promptTokens"}},{"kind":"Field","name":{"kind":"Name","value":"completionTokens"}},{"kind":"Field","name":{"kind":"Name","value":"costMicros"}},{"kind":"Field","name":{"kind":"Name","value":"latencyMs"}},{"kind":"Field","name":{"kind":"Name","value":"timeToFirstTokenMs"}},{"kind":"Field","name":{"kind":"Name","value":"tokensPerSecond"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"errorCode"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GenerationLogQuery, GenerationLogQueryVariables>;
export const LogFilterOptionsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"LogFilterOptions"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"models"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"apiKeys"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"workspaceId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"workspaceId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"prefix"}}]}}]}}]} as unknown as DocumentNode<LogFilterOptionsQuery, LogFilterOptionsQueryVariables>;
export const SessionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Session"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"me"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"workspaces"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"balanceMicros"}}]}}]}}]}}]} as unknown as DocumentNode<SessionQuery, SessionQueryVariables>;