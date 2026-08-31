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
    "\n  query Activity($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $bucket: Bucket!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n      avgTimeToFirstTokenMs\n      avgTokensPerSecond\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: $bucket) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      evidenceCoverage\n    }\n    topKeys(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      apiKeyId\n      name\n      prefix\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n    }\n  }\n": typeof types.ActivityDocument,
    "\n  query ActivityUsageByModel($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $limit: Int) {\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: $limit) {\n      modelId\n      name\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n      evidenceCoverage\n    }\n  }\n": typeof types.ActivityUsageByModelDocument,
    "\n  query GenerationLog(\n    $workspaceId: ID!\n    $filter: GenerationFilter\n    $sort: GenerationSort\n    $first: Int!\n    $after: String\n  ) {\n    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          modelId\n          modelName\n          apiKeyId\n          apiKeyName\n          promptTokens\n          completionTokens\n          costMicros\n          latencyMs\n          timeToFirstTokenMs\n          tokensPerSecond\n          status\n          errorCode\n        }\n      }\n    }\n  }\n": typeof types.GenerationLogDocument,
    "\n  query LogFilterOptions($workspaceId: ID!) {\n    models {\n      id\n      name\n    }\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      name\n      prefix\n    }\n  }\n": typeof types.LogFilterOptionsDocument,
    "\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n": typeof types.SessionDocument,
};
const documents: Documents = {
    "\n  query Activity($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $bucket: Bucket!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n      avgTimeToFirstTokenMs\n      avgTokensPerSecond\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: $bucket) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      evidenceCoverage\n    }\n    topKeys(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      apiKeyId\n      name\n      prefix\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n    }\n  }\n": types.ActivityDocument,
    "\n  query ActivityUsageByModel($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $limit: Int) {\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: $limit) {\n      modelId\n      name\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n      evidenceCoverage\n    }\n  }\n": types.ActivityUsageByModelDocument,
    "\n  query GenerationLog(\n    $workspaceId: ID!\n    $filter: GenerationFilter\n    $sort: GenerationSort\n    $first: Int!\n    $after: String\n  ) {\n    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          modelId\n          modelName\n          apiKeyId\n          apiKeyName\n          promptTokens\n          completionTokens\n          costMicros\n          latencyMs\n          timeToFirstTokenMs\n          tokensPerSecond\n          status\n          errorCode\n        }\n      }\n    }\n  }\n": types.GenerationLogDocument,
    "\n  query LogFilterOptions($workspaceId: ID!) {\n    models {\n      id\n      name\n    }\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      name\n      prefix\n    }\n  }\n": types.LogFilterOptionsDocument,
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
export function graphql(source: "\n  query Activity($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $bucket: Bucket!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n      avgTimeToFirstTokenMs\n      avgTokensPerSecond\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: $bucket) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      evidenceCoverage\n    }\n    topKeys(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      apiKeyId\n      name\n      prefix\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n    }\n  }\n"): (typeof documents)["\n  query Activity($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $bucket: Bucket!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n      avgTimeToFirstTokenMs\n      avgTokensPerSecond\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: $bucket) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      evidenceCoverage\n    }\n    topKeys(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      apiKeyId\n      name\n      prefix\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ActivityUsageByModel($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $limit: Int) {\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: $limit) {\n      modelId\n      name\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n      evidenceCoverage\n    }\n  }\n"): (typeof documents)["\n  query ActivityUsageByModel($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $limit: Int) {\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: $limit) {\n      modelId\n      name\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n      evidenceCoverage\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query GenerationLog(\n    $workspaceId: ID!\n    $filter: GenerationFilter\n    $sort: GenerationSort\n    $first: Int!\n    $after: String\n  ) {\n    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          modelId\n          modelName\n          apiKeyId\n          apiKeyName\n          promptTokens\n          completionTokens\n          costMicros\n          latencyMs\n          timeToFirstTokenMs\n          tokensPerSecond\n          status\n          errorCode\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GenerationLog(\n    $workspaceId: ID!\n    $filter: GenerationFilter\n    $sort: GenerationSort\n    $first: Int!\n    $after: String\n  ) {\n    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          modelId\n          modelName\n          apiKeyId\n          apiKeyName\n          promptTokens\n          completionTokens\n          costMicros\n          latencyMs\n          timeToFirstTokenMs\n          tokensPerSecond\n          status\n          errorCode\n        }\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query LogFilterOptions($workspaceId: ID!) {\n    models {\n      id\n      name\n    }\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      name\n      prefix\n    }\n  }\n"): (typeof documents)["\n  query LogFilterOptions($workspaceId: ID!) {\n    models {\n      id\n      name\n    }\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      name\n      prefix\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n"): (typeof documents)["\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n"];

export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> = TDocumentNode extends DocumentNode<  infer TType,  any>  ? TType  : never;