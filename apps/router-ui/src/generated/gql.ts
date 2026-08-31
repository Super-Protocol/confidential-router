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
    "\n  fragment CreditBalanceFields on CreditBalance {\n    workspaceId\n    balanceMicros\n    spendable\n    minTopUpMicros\n    autoTopUp {\n      enabled\n      available\n      thresholdMicros\n      amountMicros\n      lastChargedAt\n    }\n  }\n": typeof types.CreditBalanceFieldsFragmentDoc,
    "\n  query Credits($workspaceId: ID!, $first: Int!, $after: String) {\n    creditBalance(workspaceId: $workspaceId) {\n      ...CreditBalanceFields\n    }\n    creditTransactions(workspaceId: $workspaceId, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          kind\n          amountMicros\n          reference\n          description\n        }\n      }\n    }\n  }\n": typeof types.CreditsDocument,
    "\n  mutation CreateCheckout($input: CreateCheckoutInput!) {\n    createCheckout(input: $input) {\n      url\n      ref\n    }\n  }\n": typeof types.CreateCheckoutDocument,
    "\n  mutation SetAutoTopUp($input: SetAutoTopUpInput!) {\n    setAutoTopUp(input: $input) {\n      ...CreditBalanceFields\n    }\n  }\n": typeof types.SetAutoTopUpDocument,
    "\n  fragment EvidenceSnapshotFields on EvidenceSnapshot {\n    id\n    endpointId\n    issuedAt\n    fetchedAt\n    quoteAgeSeconds\n    quoteFormat\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    containerImages\n    measurements {\n      name\n      value\n    }\n    chain {\n      subject\n      issuer\n      notAfter\n      fingerprint\n      isRoot\n    }\n    jws\n  }\n": typeof types.EvidenceSnapshotFieldsFragmentDoc,
    "\n  fragment EndpointEvidenceFields on Endpoint {\n    id\n    name\n    hostname\n    tee\n    evidenceState\n    latestEvidence {\n      ...EvidenceSnapshotFields\n    }\n  }\n": typeof types.EndpointEvidenceFieldsFragmentDoc,
    "\n  mutation RefreshEvidence($endpointId: ID!) {\n    refreshEvidence(endpointId: $endpointId) {\n      ...EvidenceSnapshotFields\n    }\n  }\n": typeof types.RefreshEvidenceDocument,
    "\n  query GatekeeperRelease {\n    gatekeeperRelease {\n      version\n      notesUrl\n      checksumsUrl\n      publishedAt\n      fetchedAt\n      stale\n      downloads {\n        os\n        arch\n        name\n        url\n        sizeBytes\n      }\n    }\n  }\n": typeof types.GatekeeperReleaseDocument,
    "\n  fragment ApiKeyFields on ApiKey {\n    id\n    name\n    prefix\n    modelScope\n    createdAt\n    expiresAt\n    lastUsedAt\n    revokedAt\n    spendLimitMicros\n    spentTotalMicros\n    requestsPerMinute\n    tokensPerMinute\n  }\n": typeof types.ApiKeyFieldsFragmentDoc,
    "\n  query ApiKeys($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      ...ApiKeyFields\n    }\n    models {\n      id\n      name\n    }\n  }\n": typeof types.ApiKeysDocument,
    "\n  mutation CreateApiKey($input: CreateApiKeyInput!) {\n    createApiKey(input: $input) {\n      secret\n      key {\n        ...ApiKeyFields\n      }\n    }\n  }\n": typeof types.CreateApiKeyDocument,
    "\n  mutation UpdateApiKey($id: ID!, $input: UpdateApiKeyInput!) {\n    updateApiKey(id: $id, input: $input) {\n      ...ApiKeyFields\n    }\n  }\n": typeof types.UpdateApiKeyDocument,
    "\n  mutation RevokeApiKey($id: ID!) {\n    revokeApiKey(id: $id) {\n      ...ApiKeyFields\n    }\n  }\n": typeof types.RevokeApiKeyDocument,
    "\n  query GenerationLog(\n    $workspaceId: ID!\n    $filter: GenerationFilter\n    $sort: GenerationSort\n    $first: Int!\n    $after: String\n  ) {\n    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          modelId\n          modelName\n          apiKeyId\n          apiKeyName\n          promptTokens\n          completionTokens\n          costMicros\n          latencyMs\n          timeToFirstTokenMs\n          tokensPerSecond\n          status\n          errorCode\n        }\n      }\n    }\n  }\n": typeof types.GenerationLogDocument,
    "\n  query LogFilterOptions($workspaceId: ID!) {\n    models {\n      id\n      name\n    }\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      name\n      prefix\n    }\n  }\n": typeof types.LogFilterOptionsDocument,
    "\n  query ModelCatalogue {\n    models {\n      id\n      slug\n      name\n      contextLength\n      tee\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n    }\n  }\n": typeof types.ModelCatalogueDocument,
    "\n  query Overview($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    endpoints(workspaceId: $workspaceId) {\n      ...EndpointEvidenceFields\n      tokensRouted30d\n    }\n  }\n": typeof types.OverviewDocument,
    "\n  fragment UserPreferencesFields on UserPreferences {\n    archiveEvidence\n    evidenceRetentionDays\n    notifyOnMeasurementChange\n    desktopNotifications\n    emailReceipts\n  }\n": typeof types.UserPreferencesFieldsFragmentDoc,
    "\n  query Preferences {\n    me {\n      id\n      email\n      createdAt\n      preferences {\n        ...UserPreferencesFields\n      }\n    }\n  }\n": typeof types.PreferencesDocument,
    "\n  mutation UpdatePreferences($input: UpdatePreferencesInput!) {\n    updatePreferences(input: $input) {\n      ...UserPreferencesFields\n    }\n  }\n": typeof types.UpdatePreferencesDocument,
    "\n  mutation ExportEvidence($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    exportEvidence(workspaceId: $workspaceId, from: $from, to: $to) {\n      url\n      expiresAt\n    }\n  }\n": typeof types.ExportEvidenceDocument,
    "\n  query Profile($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $heatmapDays: Int!) {\n    me {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      modelId\n      name\n      spendMicros\n      requests\n    }\n    signedResponseDays(workspaceId: $workspaceId, days: $heatmapDays)\n  }\n": typeof types.ProfileDocument,
    "\n  mutation UpdateProfile($input: UpdateProfileInput!) {\n    updateProfile(input: $input) {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n  }\n": typeof types.UpdateProfileDocument,
    "\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n": typeof types.SessionDocument,
};
const documents: Documents = {
    "\n  query Activity($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $bucket: Bucket!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n      avgTimeToFirstTokenMs\n      avgTokensPerSecond\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: $bucket) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      evidenceCoverage\n    }\n    topKeys(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      apiKeyId\n      name\n      prefix\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n    }\n  }\n": types.ActivityDocument,
    "\n  query ActivityUsageByModel($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $limit: Int) {\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: $limit) {\n      modelId\n      name\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n      evidenceCoverage\n    }\n  }\n": types.ActivityUsageByModelDocument,
    "\n  fragment CreditBalanceFields on CreditBalance {\n    workspaceId\n    balanceMicros\n    spendable\n    minTopUpMicros\n    autoTopUp {\n      enabled\n      available\n      thresholdMicros\n      amountMicros\n      lastChargedAt\n    }\n  }\n": types.CreditBalanceFieldsFragmentDoc,
    "\n  query Credits($workspaceId: ID!, $first: Int!, $after: String) {\n    creditBalance(workspaceId: $workspaceId) {\n      ...CreditBalanceFields\n    }\n    creditTransactions(workspaceId: $workspaceId, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          kind\n          amountMicros\n          reference\n          description\n        }\n      }\n    }\n  }\n": types.CreditsDocument,
    "\n  mutation CreateCheckout($input: CreateCheckoutInput!) {\n    createCheckout(input: $input) {\n      url\n      ref\n    }\n  }\n": types.CreateCheckoutDocument,
    "\n  mutation SetAutoTopUp($input: SetAutoTopUpInput!) {\n    setAutoTopUp(input: $input) {\n      ...CreditBalanceFields\n    }\n  }\n": types.SetAutoTopUpDocument,
    "\n  fragment EvidenceSnapshotFields on EvidenceSnapshot {\n    id\n    endpointId\n    issuedAt\n    fetchedAt\n    quoteAgeSeconds\n    quoteFormat\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    containerImages\n    measurements {\n      name\n      value\n    }\n    chain {\n      subject\n      issuer\n      notAfter\n      fingerprint\n      isRoot\n    }\n    jws\n  }\n": types.EvidenceSnapshotFieldsFragmentDoc,
    "\n  fragment EndpointEvidenceFields on Endpoint {\n    id\n    name\n    hostname\n    tee\n    evidenceState\n    latestEvidence {\n      ...EvidenceSnapshotFields\n    }\n  }\n": types.EndpointEvidenceFieldsFragmentDoc,
    "\n  mutation RefreshEvidence($endpointId: ID!) {\n    refreshEvidence(endpointId: $endpointId) {\n      ...EvidenceSnapshotFields\n    }\n  }\n": types.RefreshEvidenceDocument,
    "\n  query GatekeeperRelease {\n    gatekeeperRelease {\n      version\n      notesUrl\n      checksumsUrl\n      publishedAt\n      fetchedAt\n      stale\n      downloads {\n        os\n        arch\n        name\n        url\n        sizeBytes\n      }\n    }\n  }\n": types.GatekeeperReleaseDocument,
    "\n  fragment ApiKeyFields on ApiKey {\n    id\n    name\n    prefix\n    modelScope\n    createdAt\n    expiresAt\n    lastUsedAt\n    revokedAt\n    spendLimitMicros\n    spentTotalMicros\n    requestsPerMinute\n    tokensPerMinute\n  }\n": types.ApiKeyFieldsFragmentDoc,
    "\n  query ApiKeys($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      ...ApiKeyFields\n    }\n    models {\n      id\n      name\n    }\n  }\n": types.ApiKeysDocument,
    "\n  mutation CreateApiKey($input: CreateApiKeyInput!) {\n    createApiKey(input: $input) {\n      secret\n      key {\n        ...ApiKeyFields\n      }\n    }\n  }\n": types.CreateApiKeyDocument,
    "\n  mutation UpdateApiKey($id: ID!, $input: UpdateApiKeyInput!) {\n    updateApiKey(id: $id, input: $input) {\n      ...ApiKeyFields\n    }\n  }\n": types.UpdateApiKeyDocument,
    "\n  mutation RevokeApiKey($id: ID!) {\n    revokeApiKey(id: $id) {\n      ...ApiKeyFields\n    }\n  }\n": types.RevokeApiKeyDocument,
    "\n  query GenerationLog(\n    $workspaceId: ID!\n    $filter: GenerationFilter\n    $sort: GenerationSort\n    $first: Int!\n    $after: String\n  ) {\n    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          modelId\n          modelName\n          apiKeyId\n          apiKeyName\n          promptTokens\n          completionTokens\n          costMicros\n          latencyMs\n          timeToFirstTokenMs\n          tokensPerSecond\n          status\n          errorCode\n        }\n      }\n    }\n  }\n": types.GenerationLogDocument,
    "\n  query LogFilterOptions($workspaceId: ID!) {\n    models {\n      id\n      name\n    }\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      name\n      prefix\n    }\n  }\n": types.LogFilterOptionsDocument,
    "\n  query ModelCatalogue {\n    models {\n      id\n      slug\n      name\n      contextLength\n      tee\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n    }\n  }\n": types.ModelCatalogueDocument,
    "\n  query Overview($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    endpoints(workspaceId: $workspaceId) {\n      ...EndpointEvidenceFields\n      tokensRouted30d\n    }\n  }\n": types.OverviewDocument,
    "\n  fragment UserPreferencesFields on UserPreferences {\n    archiveEvidence\n    evidenceRetentionDays\n    notifyOnMeasurementChange\n    desktopNotifications\n    emailReceipts\n  }\n": types.UserPreferencesFieldsFragmentDoc,
    "\n  query Preferences {\n    me {\n      id\n      email\n      createdAt\n      preferences {\n        ...UserPreferencesFields\n      }\n    }\n  }\n": types.PreferencesDocument,
    "\n  mutation UpdatePreferences($input: UpdatePreferencesInput!) {\n    updatePreferences(input: $input) {\n      ...UserPreferencesFields\n    }\n  }\n": types.UpdatePreferencesDocument,
    "\n  mutation ExportEvidence($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    exportEvidence(workspaceId: $workspaceId, from: $from, to: $to) {\n      url\n      expiresAt\n    }\n  }\n": types.ExportEvidenceDocument,
    "\n  query Profile($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $heatmapDays: Int!) {\n    me {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      modelId\n      name\n      spendMicros\n      requests\n    }\n    signedResponseDays(workspaceId: $workspaceId, days: $heatmapDays)\n  }\n": types.ProfileDocument,
    "\n  mutation UpdateProfile($input: UpdateProfileInput!) {\n    updateProfile(input: $input) {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n  }\n": types.UpdateProfileDocument,
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
export function graphql(source: "\n  fragment CreditBalanceFields on CreditBalance {\n    workspaceId\n    balanceMicros\n    spendable\n    minTopUpMicros\n    autoTopUp {\n      enabled\n      available\n      thresholdMicros\n      amountMicros\n      lastChargedAt\n    }\n  }\n"): (typeof documents)["\n  fragment CreditBalanceFields on CreditBalance {\n    workspaceId\n    balanceMicros\n    spendable\n    minTopUpMicros\n    autoTopUp {\n      enabled\n      available\n      thresholdMicros\n      amountMicros\n      lastChargedAt\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Credits($workspaceId: ID!, $first: Int!, $after: String) {\n    creditBalance(workspaceId: $workspaceId) {\n      ...CreditBalanceFields\n    }\n    creditTransactions(workspaceId: $workspaceId, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          kind\n          amountMicros\n          reference\n          description\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query Credits($workspaceId: ID!, $first: Int!, $after: String) {\n    creditBalance(workspaceId: $workspaceId) {\n      ...CreditBalanceFields\n    }\n    creditTransactions(workspaceId: $workspaceId, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          kind\n          amountMicros\n          reference\n          description\n        }\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CreateCheckout($input: CreateCheckoutInput!) {\n    createCheckout(input: $input) {\n      url\n      ref\n    }\n  }\n"): (typeof documents)["\n  mutation CreateCheckout($input: CreateCheckoutInput!) {\n    createCheckout(input: $input) {\n      url\n      ref\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SetAutoTopUp($input: SetAutoTopUpInput!) {\n    setAutoTopUp(input: $input) {\n      ...CreditBalanceFields\n    }\n  }\n"): (typeof documents)["\n  mutation SetAutoTopUp($input: SetAutoTopUpInput!) {\n    setAutoTopUp(input: $input) {\n      ...CreditBalanceFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment EvidenceSnapshotFields on EvidenceSnapshot {\n    id\n    endpointId\n    issuedAt\n    fetchedAt\n    quoteAgeSeconds\n    quoteFormat\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    containerImages\n    measurements {\n      name\n      value\n    }\n    chain {\n      subject\n      issuer\n      notAfter\n      fingerprint\n      isRoot\n    }\n    jws\n  }\n"): (typeof documents)["\n  fragment EvidenceSnapshotFields on EvidenceSnapshot {\n    id\n    endpointId\n    issuedAt\n    fetchedAt\n    quoteAgeSeconds\n    quoteFormat\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    containerImages\n    measurements {\n      name\n      value\n    }\n    chain {\n      subject\n      issuer\n      notAfter\n      fingerprint\n      isRoot\n    }\n    jws\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment EndpointEvidenceFields on Endpoint {\n    id\n    name\n    hostname\n    tee\n    evidenceState\n    latestEvidence {\n      ...EvidenceSnapshotFields\n    }\n  }\n"): (typeof documents)["\n  fragment EndpointEvidenceFields on Endpoint {\n    id\n    name\n    hostname\n    tee\n    evidenceState\n    latestEvidence {\n      ...EvidenceSnapshotFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation RefreshEvidence($endpointId: ID!) {\n    refreshEvidence(endpointId: $endpointId) {\n      ...EvidenceSnapshotFields\n    }\n  }\n"): (typeof documents)["\n  mutation RefreshEvidence($endpointId: ID!) {\n    refreshEvidence(endpointId: $endpointId) {\n      ...EvidenceSnapshotFields\n    }\n  }\n"];
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
export function graphql(source: "\n  query GenerationLog(\n    $workspaceId: ID!\n    $filter: GenerationFilter\n    $sort: GenerationSort\n    $first: Int!\n    $after: String\n  ) {\n    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          modelId\n          modelName\n          apiKeyId\n          apiKeyName\n          promptTokens\n          completionTokens\n          costMicros\n          latencyMs\n          timeToFirstTokenMs\n          tokensPerSecond\n          status\n          errorCode\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GenerationLog(\n    $workspaceId: ID!\n    $filter: GenerationFilter\n    $sort: GenerationSort\n    $first: Int!\n    $after: String\n  ) {\n    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          modelId\n          modelName\n          apiKeyId\n          apiKeyName\n          promptTokens\n          completionTokens\n          costMicros\n          latencyMs\n          timeToFirstTokenMs\n          tokensPerSecond\n          status\n          errorCode\n        }\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query LogFilterOptions($workspaceId: ID!) {\n    models {\n      id\n      name\n    }\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      name\n      prefix\n    }\n  }\n"): (typeof documents)["\n  query LogFilterOptions($workspaceId: ID!) {\n    models {\n      id\n      name\n    }\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      name\n      prefix\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ModelCatalogue {\n    models {\n      id\n      slug\n      name\n      contextLength\n      tee\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n    }\n  }\n"): (typeof documents)["\n  query ModelCatalogue {\n    models {\n      id\n      slug\n      name\n      contextLength\n      tee\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Overview($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    endpoints(workspaceId: $workspaceId) {\n      ...EndpointEvidenceFields\n      tokensRouted30d\n    }\n  }\n"): (typeof documents)["\n  query Overview($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    endpoints(workspaceId: $workspaceId) {\n      ...EndpointEvidenceFields\n      tokensRouted30d\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment UserPreferencesFields on UserPreferences {\n    archiveEvidence\n    evidenceRetentionDays\n    notifyOnMeasurementChange\n    desktopNotifications\n    emailReceipts\n  }\n"): (typeof documents)["\n  fragment UserPreferencesFields on UserPreferences {\n    archiveEvidence\n    evidenceRetentionDays\n    notifyOnMeasurementChange\n    desktopNotifications\n    emailReceipts\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Preferences {\n    me {\n      id\n      email\n      createdAt\n      preferences {\n        ...UserPreferencesFields\n      }\n    }\n  }\n"): (typeof documents)["\n  query Preferences {\n    me {\n      id\n      email\n      createdAt\n      preferences {\n        ...UserPreferencesFields\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation UpdatePreferences($input: UpdatePreferencesInput!) {\n    updatePreferences(input: $input) {\n      ...UserPreferencesFields\n    }\n  }\n"): (typeof documents)["\n  mutation UpdatePreferences($input: UpdatePreferencesInput!) {\n    updatePreferences(input: $input) {\n      ...UserPreferencesFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation ExportEvidence($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    exportEvidence(workspaceId: $workspaceId, from: $from, to: $to) {\n      url\n      expiresAt\n    }\n  }\n"): (typeof documents)["\n  mutation ExportEvidence($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    exportEvidence(workspaceId: $workspaceId, from: $from, to: $to) {\n      url\n      expiresAt\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Profile($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $heatmapDays: Int!) {\n    me {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      modelId\n      name\n      spendMicros\n      requests\n    }\n    signedResponseDays(workspaceId: $workspaceId, days: $heatmapDays)\n  }\n"): (typeof documents)["\n  query Profile($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $heatmapDays: Int!) {\n    me {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      modelId\n      name\n      spendMicros\n      requests\n    }\n    signedResponseDays(workspaceId: $workspaceId, days: $heatmapDays)\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation UpdateProfile($input: UpdateProfileInput!) {\n    updateProfile(input: $input) {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateProfile($input: UpdateProfileInput!) {\n    updateProfile(input: $input) {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n"): (typeof documents)["\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n"];

export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> = TDocumentNode extends DocumentNode<  infer TType,  any>  ? TType  : never;