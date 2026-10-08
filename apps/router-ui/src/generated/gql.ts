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
    "\n  fragment ExternalEndpointEvidenceFields on ExternalEndpointEvidence {\n    snapshotId\n    fetchedAt\n    issuedAt\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    certFingerprintHex\n    quoteFormat\n    containerImages\n    workloads {\n      kind\n      name\n      namespace\n      containers\n    }\n    measurements {\n      name\n      value\n    }\n  }\n": typeof types.ExternalEndpointEvidenceFieldsFragmentDoc,
    "\n  fragment ExternalEndpointFields on ExternalEndpoint {\n    id\n    name\n    baseUrl\n    hostname\n    enabled\n    status\n    lastCheckedAt\n    lastStage\n    lastReason\n    measurementSeen\n    measurementSource\n    evidenceDigestSeen\n    evidenceDigestSeenHex\n    pinnedEvidenceDigest\n    pinnedEvidenceDigestHex\n    pinnedCertFingerprint\n    apiKeyPrefix\n    createdAt\n    updatedAt\n    models {\n      id\n      name\n      upstreamModel\n      contextLength\n      capabilities\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n    }\n    latestEvidence {\n      ...ExternalEndpointEvidenceFields\n    }\n    pinnedEvidence {\n      ...ExternalEndpointEvidenceFields\n    }\n    events {\n      id\n      at\n      kind\n      stage\n      reason\n      measurement\n      evidenceDigest\n      evidence {\n        ...ExternalEndpointEvidenceFields\n      }\n    }\n  }\n": typeof types.ExternalEndpointFieldsFragmentDoc,
    "\n  query ExternalEndpoints {\n    externalEndpoints {\n      ...ExternalEndpointFields\n    }\n  }\n": typeof types.ExternalEndpointsDocument,
    "\n  mutation RegisterExternalEndpoint($input: RegisterExternalEndpointInput!) {\n    registerExternalEndpoint(input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n": typeof types.RegisterExternalEndpointDocument,
    "\n  mutation UpdateExternalEndpoint($id: ID!, $input: UpdateExternalEndpointInput!) {\n    updateExternalEndpoint(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n": typeof types.UpdateExternalEndpointDocument,
    "\n  query ExternalEndpointVerdict($id: ID!) {\n    externalEndpoint(id: $id) {\n      id\n      status\n      lastCheckedAt\n      lastStage\n      lastReason\n      measurementSeen\n      measurementSource\n      evidenceDigestSeen\n      evidenceDigestSeenHex\n      pinnedEvidenceDigest\n      pinnedEvidenceDigestHex\n      pinnedCertFingerprint\n      models {\n        id\n        name\n        upstreamModel\n        contextLength\n        capabilities\n        pricing {\n          promptPer1m\n          completionPer1m\n        }\n      }\n    }\n  }\n": typeof types.ExternalEndpointVerdictDocument,
    "\n  query DiscoverExternalModels($id: ID!) {\n    discoverExternalModels(id: $id) {\n      upstreamModel\n      name\n      contextLength\n      promptPer1mMicros\n      completionPer1mMicros\n      registeredAs\n    }\n  }\n": typeof types.DiscoverExternalModelsDocument,
    "\n  mutation PinExternalEndpointDigest($id: ID!, $input: PinExternalEndpointDigestInput!) {\n    pinExternalEndpointDigest(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n": typeof types.PinExternalEndpointDigestDocument,
    "\n  mutation SetExternalEndpointEnabled($id: ID!, $input: SetExternalEndpointEnabledInput!) {\n    setExternalEndpointEnabled(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n": typeof types.SetExternalEndpointEnabledDocument,
    "\n  mutation RotateExternalEndpointKey($id: ID!, $input: RotateExternalEndpointKeyInput!) {\n    rotateExternalEndpointKey(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n": typeof types.RotateExternalEndpointKeyDocument,
    "\n  query TrustedMeasurements {\n    trustedMeasurements {\n      id\n      measurement\n      note\n      addedByEmail\n      addedAt\n      admits\n    }\n  }\n": typeof types.TrustedMeasurementsDocument,
    "\n  mutation AddTrustedMeasurement($input: AddTrustedMeasurementInput!) {\n    addTrustedMeasurement(input: $input) {\n      id\n      measurement\n      note\n      addedByEmail\n      addedAt\n      admits\n    }\n  }\n": typeof types.AddTrustedMeasurementDocument,
    "\n  mutation RemoveTrustedMeasurement($id: ID!) {\n    removeTrustedMeasurement(id: $id)\n  }\n": typeof types.RemoveTrustedMeasurementDocument,
    "\n  query SignInOptions {\n    signInOptions {\n      bootstrap\n      github\n      google\n      magicLink\n      password\n      passwordMinLength\n      inviteRequired\n    }\n  }\n": typeof types.SignInOptionsDocument,
    "\n  query SignedIn {\n    me {\n      id\n    }\n  }\n": typeof types.SignedInDocument,
    "\n  query ChatScreen {\n    chatSettings {\n      enabled\n      maxMessageChars\n      maxThreads\n      maxMessagesPerThread\n      historyStorage\n      chatModelIds\n    }\n    routerEndpoint {\n      ...EndpointEvidenceFields\n    }\n    models {\n      id\n      name\n      contextLength\n      capabilities\n      tee\n      origin\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n      externalUpstream {\n        ...ExternalUpstreamFields\n      }\n    }\n  }\n": typeof types.ChatScreenDocument,
    "\n  mutation ChatCredential($input: ChatCredentialInput!) {\n    chatCredential(input: $input) {\n      apiKeyId\n      secret\n      expiresAt\n      baseUrl\n      modelScope\n    }\n  }\n": typeof types.ChatCredentialDocument,
    "\n  query ChatThreads($workspaceId: ID!) {\n    chatThreads(workspaceId: $workspaceId) {\n      id\n      title\n      modelId\n      updatedAt\n    }\n  }\n": typeof types.ChatThreadsDocument,
    "\n  query ChatThread($workspaceId: ID!, $threadId: ID!) {\n    chatThread(workspaceId: $workspaceId, threadId: $threadId) {\n      id\n      title\n      modelId\n      updatedAt\n      messages {\n        id\n        role\n        content\n        error\n        createdAt\n      }\n    }\n  }\n": typeof types.ChatThreadDocument,
    "\n  mutation CreateChatThread($input: CreateChatThreadInput!) {\n    createChatThread(input: $input) {\n      id\n      title\n      modelId\n      updatedAt\n    }\n  }\n": typeof types.CreateChatThreadDocument,
    "\n  mutation SetChatThreadModel($input: CreateChatThreadInput!, $threadId: ID!) {\n    setChatThreadModel(input: $input, threadId: $threadId) {\n      id\n      modelId\n    }\n  }\n": typeof types.SetChatThreadModelDocument,
    "\n  mutation AppendChatMessage($input: AppendChatMessageInput!) {\n    appendChatMessage(input: $input) {\n      id\n      role\n      content\n      error\n      createdAt\n    }\n  }\n": typeof types.AppendChatMessageDocument,
    "\n  mutation DeleteChatThread($workspaceId: ID!, $threadId: ID!) {\n    deleteChatThread(workspaceId: $workspaceId, threadId: $threadId)\n  }\n": typeof types.DeleteChatThreadDocument,
    "\n  fragment CreditBalanceFields on CreditBalance {\n    workspaceId\n    balanceMicros\n    spendable\n    minTopUpMicros\n    maxTopUpMicros\n    purchasesAvailable\n    autoTopUp {\n      enabled\n      available\n      thresholdMicros\n      amountMicros\n      lastChargedAt\n    }\n  }\n": typeof types.CreditBalanceFieldsFragmentDoc,
    "\n  query Credits($workspaceId: ID!, $first: Int!, $after: String) {\n    creditBalance(workspaceId: $workspaceId) {\n      ...CreditBalanceFields\n    }\n    creditTransactions(workspaceId: $workspaceId, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          kind\n          amountMicros\n          reference\n          description\n        }\n      }\n    }\n  }\n": typeof types.CreditsDocument,
    "\n  mutation CreateCheckout($input: CreateCheckoutInput!) {\n    createCheckout(input: $input) {\n      url\n      ref\n    }\n  }\n": typeof types.CreateCheckoutDocument,
    "\n  mutation SetAutoTopUp($input: SetAutoTopUpInput!) {\n    setAutoTopUp(input: $input) {\n      ...CreditBalanceFields\n    }\n  }\n": typeof types.SetAutoTopUpDocument,
    "\n  fragment EvidenceSnapshotFields on EvidenceSnapshot {\n    id\n    endpointId\n    issuedAt\n    fetchedAt\n    quoteAgeSeconds\n    quoteFormat\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    certFingerprintHex\n    containerImages\n    measurements {\n      name\n      value\n    }\n    chain {\n      subject\n      issuer\n      notAfter\n      fingerprint\n      fingerprintHex\n      isRoot\n    }\n    jws\n  }\n": typeof types.EvidenceSnapshotFieldsFragmentDoc,
    "\n  fragment EndpointEvidenceFields on Endpoint {\n    id\n    name\n    hostname\n    tee\n    evidenceState\n    declaredImages {\n      name\n      digest\n    }\n    latestEvidence {\n      ...EvidenceSnapshotFields\n    }\n  }\n": typeof types.EndpointEvidenceFieldsFragmentDoc,
    "\n  mutation RefreshEvidence($endpointId: ID!) {\n    refreshEvidence(endpointId: $endpointId) {\n      ...EvidenceSnapshotFields\n    }\n  }\n": typeof types.RefreshEvidenceDocument,
    "\n  fragment ExternalUpstreamFields on ExternalUpstream {\n    id\n    name\n    hostname\n    status\n    lastCheckedAt\n    measurementSeen\n    evidenceDigestSeen\n  }\n": typeof types.ExternalUpstreamFieldsFragmentDoc,
    "\n  query FeedbackOffer {\n    feedbackOffer {\n      eligible\n      reason\n      grantMicros\n      formUrl\n      granted {\n        creditTransactionId\n        grantMicros\n        appliedAt\n      }\n    }\n  }\n": typeof types.FeedbackOfferDocument,
    "\n  query GatekeeperRelease {\n    gatekeeperRelease {\n      version\n      notesUrl\n      checksumsUrl\n      publishedAt\n      fetchedAt\n      stale\n      downloads {\n        os\n        arch\n        name\n        url\n        sizeBytes\n      }\n    }\n  }\n": typeof types.GatekeeperReleaseDocument,
    "\n  query InviteGrantStatus($code: String) {\n    inviteGrantStatus(code: $code) {\n      reason\n      grant {\n        creditTransactionId\n        grantMicros\n        campaign\n        redeemedAt\n      }\n    }\n  }\n": typeof types.InviteGrantStatusDocument,
    "\n  fragment ApiKeyFields on ApiKey {\n    id\n    name\n    prefix\n    modelScope\n    createdAt\n    expiresAt\n    lastUsedAt\n    revokedAt\n    spendLimitMicros\n    spentTotalMicros\n    requestsPerMinute\n    tokensPerMinute\n  }\n": typeof types.ApiKeyFieldsFragmentDoc,
    "\n  query ApiKeys($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      ...ApiKeyFields\n    }\n    models {\n      id\n      name\n      available\n    }\n  }\n": typeof types.ApiKeysDocument,
    "\n  mutation CreateApiKey($input: CreateApiKeyInput!) {\n    createApiKey(input: $input) {\n      secret\n      key {\n        ...ApiKeyFields\n      }\n    }\n  }\n": typeof types.CreateApiKeyDocument,
    "\n  mutation UpdateApiKey($id: ID!, $input: UpdateApiKeyInput!) {\n    updateApiKey(id: $id, input: $input) {\n      ...ApiKeyFields\n    }\n  }\n": typeof types.UpdateApiKeyDocument,
    "\n  mutation RevokeApiKey($id: ID!) {\n    revokeApiKey(id: $id) {\n      ...ApiKeyFields\n    }\n  }\n": typeof types.RevokeApiKeyDocument,
    "\n  query GenerationLog(\n    $workspaceId: ID!\n    $filter: GenerationFilter\n    $sort: GenerationSort\n    $first: Int!\n    $after: String\n  ) {\n    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          modelId\n          modelName\n          apiKeyId\n          apiKeyName\n          promptTokens\n          completionTokens\n          costMicros\n          latencyMs\n          timeToFirstTokenMs\n          tokensPerSecond\n          status\n          errorCode\n        }\n      }\n    }\n  }\n": typeof types.GenerationLogDocument,
    "\n  query LogFilterOptions($workspaceId: ID!) {\n    models {\n      id\n      name\n    }\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      name\n      prefix\n    }\n  }\n": typeof types.LogFilterOptionsDocument,
    "\n  query ModelCatalogue {\n    models {\n      id\n      slug\n      name\n      contextLength\n      tee\n      origin\n      available\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n      externalUpstream {\n        ...ExternalUpstreamFields\n      }\n    }\n  }\n": typeof types.ModelCatalogueDocument,
    "\n  query NextStep($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      revokedAt\n    }\n    models {\n      id\n      available\n    }\n  }\n": typeof types.NextStepDocument,
    "\n  query Overview($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    endpoints(workspaceId: $workspaceId) {\n      ...EndpointEvidenceFields\n      tokensRouted30d\n    }\n  }\n": typeof types.OverviewDocument,
    "\n  fragment UserPreferencesFields on UserPreferences {\n    archiveEvidence\n    evidenceRetentionDays\n    notifyOnMeasurementChange\n    desktopNotifications\n    emailReceipts\n  }\n": typeof types.UserPreferencesFieldsFragmentDoc,
    "\n  query Preferences {\n    me {\n      id\n      email\n      createdAt\n      preferences {\n        ...UserPreferencesFields\n      }\n    }\n  }\n": typeof types.PreferencesDocument,
    "\n  mutation UpdatePreferences($input: UpdatePreferencesInput!) {\n    updatePreferences(input: $input) {\n      ...UserPreferencesFields\n    }\n  }\n": typeof types.UpdatePreferencesDocument,
    "\n  mutation ExportEvidence($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    exportEvidence(workspaceId: $workspaceId, from: $from, to: $to) {\n      url\n      expiresAt\n    }\n  }\n": typeof types.ExportEvidenceDocument,
    "\n  query Profile($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $heatmapDays: Int!) {\n    me {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      modelId\n      name\n      spendMicros\n      requests\n    }\n    signedResponseDays(workspaceId: $workspaceId, days: $heatmapDays)\n  }\n": typeof types.ProfileDocument,
    "\n  mutation UpdateProfile($input: UpdateProfileInput!) {\n    updateProfile(input: $input) {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n  }\n": typeof types.UpdateProfileDocument,
    "\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n": typeof types.SessionDocument,
    "\n  query ViewerIsAdmin {\n    me {\n      id\n      isAdmin\n    }\n  }\n": typeof types.ViewerIsAdminDocument,
};
const documents: Documents = {
    "\n  query Activity($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $bucket: Bucket!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n      avgTimeToFirstTokenMs\n      avgTokensPerSecond\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: $bucket) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      evidenceCoverage\n    }\n    topKeys(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      apiKeyId\n      name\n      prefix\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n    }\n  }\n": types.ActivityDocument,
    "\n  query ActivityUsageByModel($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $limit: Int) {\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: $limit) {\n      modelId\n      name\n      requests\n      promptTokens\n      completionTokens\n      spendMicros\n      evidenceCoverage\n    }\n  }\n": types.ActivityUsageByModelDocument,
    "\n  fragment ExternalEndpointEvidenceFields on ExternalEndpointEvidence {\n    snapshotId\n    fetchedAt\n    issuedAt\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    certFingerprintHex\n    quoteFormat\n    containerImages\n    workloads {\n      kind\n      name\n      namespace\n      containers\n    }\n    measurements {\n      name\n      value\n    }\n  }\n": types.ExternalEndpointEvidenceFieldsFragmentDoc,
    "\n  fragment ExternalEndpointFields on ExternalEndpoint {\n    id\n    name\n    baseUrl\n    hostname\n    enabled\n    status\n    lastCheckedAt\n    lastStage\n    lastReason\n    measurementSeen\n    measurementSource\n    evidenceDigestSeen\n    evidenceDigestSeenHex\n    pinnedEvidenceDigest\n    pinnedEvidenceDigestHex\n    pinnedCertFingerprint\n    apiKeyPrefix\n    createdAt\n    updatedAt\n    models {\n      id\n      name\n      upstreamModel\n      contextLength\n      capabilities\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n    }\n    latestEvidence {\n      ...ExternalEndpointEvidenceFields\n    }\n    pinnedEvidence {\n      ...ExternalEndpointEvidenceFields\n    }\n    events {\n      id\n      at\n      kind\n      stage\n      reason\n      measurement\n      evidenceDigest\n      evidence {\n        ...ExternalEndpointEvidenceFields\n      }\n    }\n  }\n": types.ExternalEndpointFieldsFragmentDoc,
    "\n  query ExternalEndpoints {\n    externalEndpoints {\n      ...ExternalEndpointFields\n    }\n  }\n": types.ExternalEndpointsDocument,
    "\n  mutation RegisterExternalEndpoint($input: RegisterExternalEndpointInput!) {\n    registerExternalEndpoint(input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n": types.RegisterExternalEndpointDocument,
    "\n  mutation UpdateExternalEndpoint($id: ID!, $input: UpdateExternalEndpointInput!) {\n    updateExternalEndpoint(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n": types.UpdateExternalEndpointDocument,
    "\n  query ExternalEndpointVerdict($id: ID!) {\n    externalEndpoint(id: $id) {\n      id\n      status\n      lastCheckedAt\n      lastStage\n      lastReason\n      measurementSeen\n      measurementSource\n      evidenceDigestSeen\n      evidenceDigestSeenHex\n      pinnedEvidenceDigest\n      pinnedEvidenceDigestHex\n      pinnedCertFingerprint\n      models {\n        id\n        name\n        upstreamModel\n        contextLength\n        capabilities\n        pricing {\n          promptPer1m\n          completionPer1m\n        }\n      }\n    }\n  }\n": types.ExternalEndpointVerdictDocument,
    "\n  query DiscoverExternalModels($id: ID!) {\n    discoverExternalModels(id: $id) {\n      upstreamModel\n      name\n      contextLength\n      promptPer1mMicros\n      completionPer1mMicros\n      registeredAs\n    }\n  }\n": types.DiscoverExternalModelsDocument,
    "\n  mutation PinExternalEndpointDigest($id: ID!, $input: PinExternalEndpointDigestInput!) {\n    pinExternalEndpointDigest(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n": types.PinExternalEndpointDigestDocument,
    "\n  mutation SetExternalEndpointEnabled($id: ID!, $input: SetExternalEndpointEnabledInput!) {\n    setExternalEndpointEnabled(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n": types.SetExternalEndpointEnabledDocument,
    "\n  mutation RotateExternalEndpointKey($id: ID!, $input: RotateExternalEndpointKeyInput!) {\n    rotateExternalEndpointKey(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n": types.RotateExternalEndpointKeyDocument,
    "\n  query TrustedMeasurements {\n    trustedMeasurements {\n      id\n      measurement\n      note\n      addedByEmail\n      addedAt\n      admits\n    }\n  }\n": types.TrustedMeasurementsDocument,
    "\n  mutation AddTrustedMeasurement($input: AddTrustedMeasurementInput!) {\n    addTrustedMeasurement(input: $input) {\n      id\n      measurement\n      note\n      addedByEmail\n      addedAt\n      admits\n    }\n  }\n": types.AddTrustedMeasurementDocument,
    "\n  mutation RemoveTrustedMeasurement($id: ID!) {\n    removeTrustedMeasurement(id: $id)\n  }\n": types.RemoveTrustedMeasurementDocument,
    "\n  query SignInOptions {\n    signInOptions {\n      bootstrap\n      github\n      google\n      magicLink\n      password\n      passwordMinLength\n      inviteRequired\n    }\n  }\n": types.SignInOptionsDocument,
    "\n  query SignedIn {\n    me {\n      id\n    }\n  }\n": types.SignedInDocument,
    "\n  query ChatScreen {\n    chatSettings {\n      enabled\n      maxMessageChars\n      maxThreads\n      maxMessagesPerThread\n      historyStorage\n      chatModelIds\n    }\n    routerEndpoint {\n      ...EndpointEvidenceFields\n    }\n    models {\n      id\n      name\n      contextLength\n      capabilities\n      tee\n      origin\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n      externalUpstream {\n        ...ExternalUpstreamFields\n      }\n    }\n  }\n": types.ChatScreenDocument,
    "\n  mutation ChatCredential($input: ChatCredentialInput!) {\n    chatCredential(input: $input) {\n      apiKeyId\n      secret\n      expiresAt\n      baseUrl\n      modelScope\n    }\n  }\n": types.ChatCredentialDocument,
    "\n  query ChatThreads($workspaceId: ID!) {\n    chatThreads(workspaceId: $workspaceId) {\n      id\n      title\n      modelId\n      updatedAt\n    }\n  }\n": types.ChatThreadsDocument,
    "\n  query ChatThread($workspaceId: ID!, $threadId: ID!) {\n    chatThread(workspaceId: $workspaceId, threadId: $threadId) {\n      id\n      title\n      modelId\n      updatedAt\n      messages {\n        id\n        role\n        content\n        error\n        createdAt\n      }\n    }\n  }\n": types.ChatThreadDocument,
    "\n  mutation CreateChatThread($input: CreateChatThreadInput!) {\n    createChatThread(input: $input) {\n      id\n      title\n      modelId\n      updatedAt\n    }\n  }\n": types.CreateChatThreadDocument,
    "\n  mutation SetChatThreadModel($input: CreateChatThreadInput!, $threadId: ID!) {\n    setChatThreadModel(input: $input, threadId: $threadId) {\n      id\n      modelId\n    }\n  }\n": types.SetChatThreadModelDocument,
    "\n  mutation AppendChatMessage($input: AppendChatMessageInput!) {\n    appendChatMessage(input: $input) {\n      id\n      role\n      content\n      error\n      createdAt\n    }\n  }\n": types.AppendChatMessageDocument,
    "\n  mutation DeleteChatThread($workspaceId: ID!, $threadId: ID!) {\n    deleteChatThread(workspaceId: $workspaceId, threadId: $threadId)\n  }\n": types.DeleteChatThreadDocument,
    "\n  fragment CreditBalanceFields on CreditBalance {\n    workspaceId\n    balanceMicros\n    spendable\n    minTopUpMicros\n    maxTopUpMicros\n    purchasesAvailable\n    autoTopUp {\n      enabled\n      available\n      thresholdMicros\n      amountMicros\n      lastChargedAt\n    }\n  }\n": types.CreditBalanceFieldsFragmentDoc,
    "\n  query Credits($workspaceId: ID!, $first: Int!, $after: String) {\n    creditBalance(workspaceId: $workspaceId) {\n      ...CreditBalanceFields\n    }\n    creditTransactions(workspaceId: $workspaceId, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          kind\n          amountMicros\n          reference\n          description\n        }\n      }\n    }\n  }\n": types.CreditsDocument,
    "\n  mutation CreateCheckout($input: CreateCheckoutInput!) {\n    createCheckout(input: $input) {\n      url\n      ref\n    }\n  }\n": types.CreateCheckoutDocument,
    "\n  mutation SetAutoTopUp($input: SetAutoTopUpInput!) {\n    setAutoTopUp(input: $input) {\n      ...CreditBalanceFields\n    }\n  }\n": types.SetAutoTopUpDocument,
    "\n  fragment EvidenceSnapshotFields on EvidenceSnapshot {\n    id\n    endpointId\n    issuedAt\n    fetchedAt\n    quoteAgeSeconds\n    quoteFormat\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    certFingerprintHex\n    containerImages\n    measurements {\n      name\n      value\n    }\n    chain {\n      subject\n      issuer\n      notAfter\n      fingerprint\n      fingerprintHex\n      isRoot\n    }\n    jws\n  }\n": types.EvidenceSnapshotFieldsFragmentDoc,
    "\n  fragment EndpointEvidenceFields on Endpoint {\n    id\n    name\n    hostname\n    tee\n    evidenceState\n    declaredImages {\n      name\n      digest\n    }\n    latestEvidence {\n      ...EvidenceSnapshotFields\n    }\n  }\n": types.EndpointEvidenceFieldsFragmentDoc,
    "\n  mutation RefreshEvidence($endpointId: ID!) {\n    refreshEvidence(endpointId: $endpointId) {\n      ...EvidenceSnapshotFields\n    }\n  }\n": types.RefreshEvidenceDocument,
    "\n  fragment ExternalUpstreamFields on ExternalUpstream {\n    id\n    name\n    hostname\n    status\n    lastCheckedAt\n    measurementSeen\n    evidenceDigestSeen\n  }\n": types.ExternalUpstreamFieldsFragmentDoc,
    "\n  query FeedbackOffer {\n    feedbackOffer {\n      eligible\n      reason\n      grantMicros\n      formUrl\n      granted {\n        creditTransactionId\n        grantMicros\n        appliedAt\n      }\n    }\n  }\n": types.FeedbackOfferDocument,
    "\n  query GatekeeperRelease {\n    gatekeeperRelease {\n      version\n      notesUrl\n      checksumsUrl\n      publishedAt\n      fetchedAt\n      stale\n      downloads {\n        os\n        arch\n        name\n        url\n        sizeBytes\n      }\n    }\n  }\n": types.GatekeeperReleaseDocument,
    "\n  query InviteGrantStatus($code: String) {\n    inviteGrantStatus(code: $code) {\n      reason\n      grant {\n        creditTransactionId\n        grantMicros\n        campaign\n        redeemedAt\n      }\n    }\n  }\n": types.InviteGrantStatusDocument,
    "\n  fragment ApiKeyFields on ApiKey {\n    id\n    name\n    prefix\n    modelScope\n    createdAt\n    expiresAt\n    lastUsedAt\n    revokedAt\n    spendLimitMicros\n    spentTotalMicros\n    requestsPerMinute\n    tokensPerMinute\n  }\n": types.ApiKeyFieldsFragmentDoc,
    "\n  query ApiKeys($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      ...ApiKeyFields\n    }\n    models {\n      id\n      name\n      available\n    }\n  }\n": types.ApiKeysDocument,
    "\n  mutation CreateApiKey($input: CreateApiKeyInput!) {\n    createApiKey(input: $input) {\n      secret\n      key {\n        ...ApiKeyFields\n      }\n    }\n  }\n": types.CreateApiKeyDocument,
    "\n  mutation UpdateApiKey($id: ID!, $input: UpdateApiKeyInput!) {\n    updateApiKey(id: $id, input: $input) {\n      ...ApiKeyFields\n    }\n  }\n": types.UpdateApiKeyDocument,
    "\n  mutation RevokeApiKey($id: ID!) {\n    revokeApiKey(id: $id) {\n      ...ApiKeyFields\n    }\n  }\n": types.RevokeApiKeyDocument,
    "\n  query GenerationLog(\n    $workspaceId: ID!\n    $filter: GenerationFilter\n    $sort: GenerationSort\n    $first: Int!\n    $after: String\n  ) {\n    generations(workspaceId: $workspaceId, filter: $filter, sort: $sort, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          createdAt\n          modelId\n          modelName\n          apiKeyId\n          apiKeyName\n          promptTokens\n          completionTokens\n          costMicros\n          latencyMs\n          timeToFirstTokenMs\n          tokensPerSecond\n          status\n          errorCode\n        }\n      }\n    }\n  }\n": types.GenerationLogDocument,
    "\n  query LogFilterOptions($workspaceId: ID!) {\n    models {\n      id\n      name\n    }\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      name\n      prefix\n    }\n  }\n": types.LogFilterOptionsDocument,
    "\n  query ModelCatalogue {\n    models {\n      id\n      slug\n      name\n      contextLength\n      tee\n      origin\n      available\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n      externalUpstream {\n        ...ExternalUpstreamFields\n      }\n    }\n  }\n": types.ModelCatalogueDocument,
    "\n  query NextStep($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      revokedAt\n    }\n    models {\n      id\n      available\n    }\n  }\n": types.NextStepDocument,
    "\n  query Overview($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    activitySummary(workspaceId: $workspaceId, from: $from, to: $to) {\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n      coveredRequests\n      evidenceCoverage\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    endpoints(workspaceId: $workspaceId) {\n      ...EndpointEvidenceFields\n      tokensRouted30d\n    }\n  }\n": types.OverviewDocument,
    "\n  fragment UserPreferencesFields on UserPreferences {\n    archiveEvidence\n    evidenceRetentionDays\n    notifyOnMeasurementChange\n    desktopNotifications\n    emailReceipts\n  }\n": types.UserPreferencesFieldsFragmentDoc,
    "\n  query Preferences {\n    me {\n      id\n      email\n      createdAt\n      preferences {\n        ...UserPreferencesFields\n      }\n    }\n  }\n": types.PreferencesDocument,
    "\n  mutation UpdatePreferences($input: UpdatePreferencesInput!) {\n    updatePreferences(input: $input) {\n      ...UserPreferencesFields\n    }\n  }\n": types.UpdatePreferencesDocument,
    "\n  mutation ExportEvidence($workspaceId: ID!, $from: DateTime!, $to: DateTime!) {\n    exportEvidence(workspaceId: $workspaceId, from: $from, to: $to) {\n      url\n      expiresAt\n    }\n  }\n": types.ExportEvidenceDocument,
    "\n  query Profile($workspaceId: ID!, $from: DateTime!, $to: DateTime!, $heatmapDays: Int!) {\n    me {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n    activitySeries(workspaceId: $workspaceId, from: $from, to: $to, bucket: DAY) {\n      bucket\n      spendMicros\n      requests\n      promptTokens\n      completionTokens\n    }\n    usageByModel(workspaceId: $workspaceId, from: $from, to: $to, limit: 5) {\n      modelId\n      name\n      spendMicros\n      requests\n    }\n    signedResponseDays(workspaceId: $workspaceId, days: $heatmapDays)\n  }\n": types.ProfileDocument,
    "\n  mutation UpdateProfile($input: UpdateProfileInput!) {\n    updateProfile(input: $input) {\n      id\n      name\n      email\n      avatarUrl\n      createdAt\n    }\n  }\n": types.UpdateProfileDocument,
    "\n  query Session {\n    me {\n      id\n      email\n      name\n      avatarUrl\n      workspaces {\n        id\n        name\n        slug\n        role\n        balanceMicros\n      }\n    }\n  }\n": types.SessionDocument,
    "\n  query ViewerIsAdmin {\n    me {\n      id\n      isAdmin\n    }\n  }\n": types.ViewerIsAdminDocument,
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
export function graphql(source: "\n  fragment ExternalEndpointEvidenceFields on ExternalEndpointEvidence {\n    snapshotId\n    fetchedAt\n    issuedAt\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    certFingerprintHex\n    quoteFormat\n    containerImages\n    workloads {\n      kind\n      name\n      namespace\n      containers\n    }\n    measurements {\n      name\n      value\n    }\n  }\n"): (typeof documents)["\n  fragment ExternalEndpointEvidenceFields on ExternalEndpointEvidence {\n    snapshotId\n    fetchedAt\n    issuedAt\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    certFingerprintHex\n    quoteFormat\n    containerImages\n    workloads {\n      kind\n      name\n      namespace\n      containers\n    }\n    measurements {\n      name\n      value\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment ExternalEndpointFields on ExternalEndpoint {\n    id\n    name\n    baseUrl\n    hostname\n    enabled\n    status\n    lastCheckedAt\n    lastStage\n    lastReason\n    measurementSeen\n    measurementSource\n    evidenceDigestSeen\n    evidenceDigestSeenHex\n    pinnedEvidenceDigest\n    pinnedEvidenceDigestHex\n    pinnedCertFingerprint\n    apiKeyPrefix\n    createdAt\n    updatedAt\n    models {\n      id\n      name\n      upstreamModel\n      contextLength\n      capabilities\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n    }\n    latestEvidence {\n      ...ExternalEndpointEvidenceFields\n    }\n    pinnedEvidence {\n      ...ExternalEndpointEvidenceFields\n    }\n    events {\n      id\n      at\n      kind\n      stage\n      reason\n      measurement\n      evidenceDigest\n      evidence {\n        ...ExternalEndpointEvidenceFields\n      }\n    }\n  }\n"): (typeof documents)["\n  fragment ExternalEndpointFields on ExternalEndpoint {\n    id\n    name\n    baseUrl\n    hostname\n    enabled\n    status\n    lastCheckedAt\n    lastStage\n    lastReason\n    measurementSeen\n    measurementSource\n    evidenceDigestSeen\n    evidenceDigestSeenHex\n    pinnedEvidenceDigest\n    pinnedEvidenceDigestHex\n    pinnedCertFingerprint\n    apiKeyPrefix\n    createdAt\n    updatedAt\n    models {\n      id\n      name\n      upstreamModel\n      contextLength\n      capabilities\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n    }\n    latestEvidence {\n      ...ExternalEndpointEvidenceFields\n    }\n    pinnedEvidence {\n      ...ExternalEndpointEvidenceFields\n    }\n    events {\n      id\n      at\n      kind\n      stage\n      reason\n      measurement\n      evidenceDigest\n      evidence {\n        ...ExternalEndpointEvidenceFields\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ExternalEndpoints {\n    externalEndpoints {\n      ...ExternalEndpointFields\n    }\n  }\n"): (typeof documents)["\n  query ExternalEndpoints {\n    externalEndpoints {\n      ...ExternalEndpointFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation RegisterExternalEndpoint($input: RegisterExternalEndpointInput!) {\n    registerExternalEndpoint(input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n"): (typeof documents)["\n  mutation RegisterExternalEndpoint($input: RegisterExternalEndpointInput!) {\n    registerExternalEndpoint(input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation UpdateExternalEndpoint($id: ID!, $input: UpdateExternalEndpointInput!) {\n    updateExternalEndpoint(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateExternalEndpoint($id: ID!, $input: UpdateExternalEndpointInput!) {\n    updateExternalEndpoint(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ExternalEndpointVerdict($id: ID!) {\n    externalEndpoint(id: $id) {\n      id\n      status\n      lastCheckedAt\n      lastStage\n      lastReason\n      measurementSeen\n      measurementSource\n      evidenceDigestSeen\n      evidenceDigestSeenHex\n      pinnedEvidenceDigest\n      pinnedEvidenceDigestHex\n      pinnedCertFingerprint\n      models {\n        id\n        name\n        upstreamModel\n        contextLength\n        capabilities\n        pricing {\n          promptPer1m\n          completionPer1m\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query ExternalEndpointVerdict($id: ID!) {\n    externalEndpoint(id: $id) {\n      id\n      status\n      lastCheckedAt\n      lastStage\n      lastReason\n      measurementSeen\n      measurementSource\n      evidenceDigestSeen\n      evidenceDigestSeenHex\n      pinnedEvidenceDigest\n      pinnedEvidenceDigestHex\n      pinnedCertFingerprint\n      models {\n        id\n        name\n        upstreamModel\n        contextLength\n        capabilities\n        pricing {\n          promptPer1m\n          completionPer1m\n        }\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query DiscoverExternalModels($id: ID!) {\n    discoverExternalModels(id: $id) {\n      upstreamModel\n      name\n      contextLength\n      promptPer1mMicros\n      completionPer1mMicros\n      registeredAs\n    }\n  }\n"): (typeof documents)["\n  query DiscoverExternalModels($id: ID!) {\n    discoverExternalModels(id: $id) {\n      upstreamModel\n      name\n      contextLength\n      promptPer1mMicros\n      completionPer1mMicros\n      registeredAs\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation PinExternalEndpointDigest($id: ID!, $input: PinExternalEndpointDigestInput!) {\n    pinExternalEndpointDigest(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n"): (typeof documents)["\n  mutation PinExternalEndpointDigest($id: ID!, $input: PinExternalEndpointDigestInput!) {\n    pinExternalEndpointDigest(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SetExternalEndpointEnabled($id: ID!, $input: SetExternalEndpointEnabledInput!) {\n    setExternalEndpointEnabled(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n"): (typeof documents)["\n  mutation SetExternalEndpointEnabled($id: ID!, $input: SetExternalEndpointEnabledInput!) {\n    setExternalEndpointEnabled(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation RotateExternalEndpointKey($id: ID!, $input: RotateExternalEndpointKeyInput!) {\n    rotateExternalEndpointKey(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n"): (typeof documents)["\n  mutation RotateExternalEndpointKey($id: ID!, $input: RotateExternalEndpointKeyInput!) {\n    rotateExternalEndpointKey(id: $id, input: $input) {\n      ...ExternalEndpointFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query TrustedMeasurements {\n    trustedMeasurements {\n      id\n      measurement\n      note\n      addedByEmail\n      addedAt\n      admits\n    }\n  }\n"): (typeof documents)["\n  query TrustedMeasurements {\n    trustedMeasurements {\n      id\n      measurement\n      note\n      addedByEmail\n      addedAt\n      admits\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation AddTrustedMeasurement($input: AddTrustedMeasurementInput!) {\n    addTrustedMeasurement(input: $input) {\n      id\n      measurement\n      note\n      addedByEmail\n      addedAt\n      admits\n    }\n  }\n"): (typeof documents)["\n  mutation AddTrustedMeasurement($input: AddTrustedMeasurementInput!) {\n    addTrustedMeasurement(input: $input) {\n      id\n      measurement\n      note\n      addedByEmail\n      addedAt\n      admits\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation RemoveTrustedMeasurement($id: ID!) {\n    removeTrustedMeasurement(id: $id)\n  }\n"): (typeof documents)["\n  mutation RemoveTrustedMeasurement($id: ID!) {\n    removeTrustedMeasurement(id: $id)\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query SignInOptions {\n    signInOptions {\n      bootstrap\n      github\n      google\n      magicLink\n      password\n      passwordMinLength\n      inviteRequired\n    }\n  }\n"): (typeof documents)["\n  query SignInOptions {\n    signInOptions {\n      bootstrap\n      github\n      google\n      magicLink\n      password\n      passwordMinLength\n      inviteRequired\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query SignedIn {\n    me {\n      id\n    }\n  }\n"): (typeof documents)["\n  query SignedIn {\n    me {\n      id\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ChatScreen {\n    chatSettings {\n      enabled\n      maxMessageChars\n      maxThreads\n      maxMessagesPerThread\n      historyStorage\n      chatModelIds\n    }\n    routerEndpoint {\n      ...EndpointEvidenceFields\n    }\n    models {\n      id\n      name\n      contextLength\n      capabilities\n      tee\n      origin\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n      externalUpstream {\n        ...ExternalUpstreamFields\n      }\n    }\n  }\n"): (typeof documents)["\n  query ChatScreen {\n    chatSettings {\n      enabled\n      maxMessageChars\n      maxThreads\n      maxMessagesPerThread\n      historyStorage\n      chatModelIds\n    }\n    routerEndpoint {\n      ...EndpointEvidenceFields\n    }\n    models {\n      id\n      name\n      contextLength\n      capabilities\n      tee\n      origin\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n      externalUpstream {\n        ...ExternalUpstreamFields\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation ChatCredential($input: ChatCredentialInput!) {\n    chatCredential(input: $input) {\n      apiKeyId\n      secret\n      expiresAt\n      baseUrl\n      modelScope\n    }\n  }\n"): (typeof documents)["\n  mutation ChatCredential($input: ChatCredentialInput!) {\n    chatCredential(input: $input) {\n      apiKeyId\n      secret\n      expiresAt\n      baseUrl\n      modelScope\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ChatThreads($workspaceId: ID!) {\n    chatThreads(workspaceId: $workspaceId) {\n      id\n      title\n      modelId\n      updatedAt\n    }\n  }\n"): (typeof documents)["\n  query ChatThreads($workspaceId: ID!) {\n    chatThreads(workspaceId: $workspaceId) {\n      id\n      title\n      modelId\n      updatedAt\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ChatThread($workspaceId: ID!, $threadId: ID!) {\n    chatThread(workspaceId: $workspaceId, threadId: $threadId) {\n      id\n      title\n      modelId\n      updatedAt\n      messages {\n        id\n        role\n        content\n        error\n        createdAt\n      }\n    }\n  }\n"): (typeof documents)["\n  query ChatThread($workspaceId: ID!, $threadId: ID!) {\n    chatThread(workspaceId: $workspaceId, threadId: $threadId) {\n      id\n      title\n      modelId\n      updatedAt\n      messages {\n        id\n        role\n        content\n        error\n        createdAt\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CreateChatThread($input: CreateChatThreadInput!) {\n    createChatThread(input: $input) {\n      id\n      title\n      modelId\n      updatedAt\n    }\n  }\n"): (typeof documents)["\n  mutation CreateChatThread($input: CreateChatThreadInput!) {\n    createChatThread(input: $input) {\n      id\n      title\n      modelId\n      updatedAt\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SetChatThreadModel($input: CreateChatThreadInput!, $threadId: ID!) {\n    setChatThreadModel(input: $input, threadId: $threadId) {\n      id\n      modelId\n    }\n  }\n"): (typeof documents)["\n  mutation SetChatThreadModel($input: CreateChatThreadInput!, $threadId: ID!) {\n    setChatThreadModel(input: $input, threadId: $threadId) {\n      id\n      modelId\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation AppendChatMessage($input: AppendChatMessageInput!) {\n    appendChatMessage(input: $input) {\n      id\n      role\n      content\n      error\n      createdAt\n    }\n  }\n"): (typeof documents)["\n  mutation AppendChatMessage($input: AppendChatMessageInput!) {\n    appendChatMessage(input: $input) {\n      id\n      role\n      content\n      error\n      createdAt\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DeleteChatThread($workspaceId: ID!, $threadId: ID!) {\n    deleteChatThread(workspaceId: $workspaceId, threadId: $threadId)\n  }\n"): (typeof documents)["\n  mutation DeleteChatThread($workspaceId: ID!, $threadId: ID!) {\n    deleteChatThread(workspaceId: $workspaceId, threadId: $threadId)\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment CreditBalanceFields on CreditBalance {\n    workspaceId\n    balanceMicros\n    spendable\n    minTopUpMicros\n    maxTopUpMicros\n    purchasesAvailable\n    autoTopUp {\n      enabled\n      available\n      thresholdMicros\n      amountMicros\n      lastChargedAt\n    }\n  }\n"): (typeof documents)["\n  fragment CreditBalanceFields on CreditBalance {\n    workspaceId\n    balanceMicros\n    spendable\n    minTopUpMicros\n    maxTopUpMicros\n    purchasesAvailable\n    autoTopUp {\n      enabled\n      available\n      thresholdMicros\n      amountMicros\n      lastChargedAt\n    }\n  }\n"];
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
export function graphql(source: "\n  fragment EvidenceSnapshotFields on EvidenceSnapshot {\n    id\n    endpointId\n    issuedAt\n    fetchedAt\n    quoteAgeSeconds\n    quoteFormat\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    certFingerprintHex\n    containerImages\n    measurements {\n      name\n      value\n    }\n    chain {\n      subject\n      issuer\n      notAfter\n      fingerprint\n      fingerprintHex\n      isRoot\n    }\n    jws\n  }\n"): (typeof documents)["\n  fragment EvidenceSnapshotFields on EvidenceSnapshot {\n    id\n    endpointId\n    issuedAt\n    fetchedAt\n    quoteAgeSeconds\n    quoteFormat\n    evidenceDigest\n    evidenceDigestHex\n    certFingerprint\n    certFingerprintHex\n    containerImages\n    measurements {\n      name\n      value\n    }\n    chain {\n      subject\n      issuer\n      notAfter\n      fingerprint\n      fingerprintHex\n      isRoot\n    }\n    jws\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment EndpointEvidenceFields on Endpoint {\n    id\n    name\n    hostname\n    tee\n    evidenceState\n    declaredImages {\n      name\n      digest\n    }\n    latestEvidence {\n      ...EvidenceSnapshotFields\n    }\n  }\n"): (typeof documents)["\n  fragment EndpointEvidenceFields on Endpoint {\n    id\n    name\n    hostname\n    tee\n    evidenceState\n    declaredImages {\n      name\n      digest\n    }\n    latestEvidence {\n      ...EvidenceSnapshotFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation RefreshEvidence($endpointId: ID!) {\n    refreshEvidence(endpointId: $endpointId) {\n      ...EvidenceSnapshotFields\n    }\n  }\n"): (typeof documents)["\n  mutation RefreshEvidence($endpointId: ID!) {\n    refreshEvidence(endpointId: $endpointId) {\n      ...EvidenceSnapshotFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment ExternalUpstreamFields on ExternalUpstream {\n    id\n    name\n    hostname\n    status\n    lastCheckedAt\n    measurementSeen\n    evidenceDigestSeen\n  }\n"): (typeof documents)["\n  fragment ExternalUpstreamFields on ExternalUpstream {\n    id\n    name\n    hostname\n    status\n    lastCheckedAt\n    measurementSeen\n    evidenceDigestSeen\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query FeedbackOffer {\n    feedbackOffer {\n      eligible\n      reason\n      grantMicros\n      formUrl\n      granted {\n        creditTransactionId\n        grantMicros\n        appliedAt\n      }\n    }\n  }\n"): (typeof documents)["\n  query FeedbackOffer {\n    feedbackOffer {\n      eligible\n      reason\n      grantMicros\n      formUrl\n      granted {\n        creditTransactionId\n        grantMicros\n        appliedAt\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query GatekeeperRelease {\n    gatekeeperRelease {\n      version\n      notesUrl\n      checksumsUrl\n      publishedAt\n      fetchedAt\n      stale\n      downloads {\n        os\n        arch\n        name\n        url\n        sizeBytes\n      }\n    }\n  }\n"): (typeof documents)["\n  query GatekeeperRelease {\n    gatekeeperRelease {\n      version\n      notesUrl\n      checksumsUrl\n      publishedAt\n      fetchedAt\n      stale\n      downloads {\n        os\n        arch\n        name\n        url\n        sizeBytes\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query InviteGrantStatus($code: String) {\n    inviteGrantStatus(code: $code) {\n      reason\n      grant {\n        creditTransactionId\n        grantMicros\n        campaign\n        redeemedAt\n      }\n    }\n  }\n"): (typeof documents)["\n  query InviteGrantStatus($code: String) {\n    inviteGrantStatus(code: $code) {\n      reason\n      grant {\n        creditTransactionId\n        grantMicros\n        campaign\n        redeemedAt\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment ApiKeyFields on ApiKey {\n    id\n    name\n    prefix\n    modelScope\n    createdAt\n    expiresAt\n    lastUsedAt\n    revokedAt\n    spendLimitMicros\n    spentTotalMicros\n    requestsPerMinute\n    tokensPerMinute\n  }\n"): (typeof documents)["\n  fragment ApiKeyFields on ApiKey {\n    id\n    name\n    prefix\n    modelScope\n    createdAt\n    expiresAt\n    lastUsedAt\n    revokedAt\n    spendLimitMicros\n    spentTotalMicros\n    requestsPerMinute\n    tokensPerMinute\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ApiKeys($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      ...ApiKeyFields\n    }\n    models {\n      id\n      name\n      available\n    }\n  }\n"): (typeof documents)["\n  query ApiKeys($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      ...ApiKeyFields\n    }\n    models {\n      id\n      name\n      available\n    }\n  }\n"];
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
export function graphql(source: "\n  query ModelCatalogue {\n    models {\n      id\n      slug\n      name\n      contextLength\n      tee\n      origin\n      available\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n      externalUpstream {\n        ...ExternalUpstreamFields\n      }\n    }\n  }\n"): (typeof documents)["\n  query ModelCatalogue {\n    models {\n      id\n      slug\n      name\n      contextLength\n      tee\n      origin\n      available\n      pricing {\n        promptPer1m\n        completionPer1m\n      }\n      endpoint {\n        ...EndpointEvidenceFields\n      }\n      externalUpstream {\n        ...ExternalUpstreamFields\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query NextStep($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      revokedAt\n    }\n    models {\n      id\n      available\n    }\n  }\n"): (typeof documents)["\n  query NextStep($workspaceId: ID!) {\n    apiKeys(workspaceId: $workspaceId) {\n      id\n      revokedAt\n    }\n    models {\n      id\n      available\n    }\n  }\n"];
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
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ViewerIsAdmin {\n    me {\n      id\n      isAdmin\n    }\n  }\n"): (typeof documents)["\n  query ViewerIsAdmin {\n    me {\n      id\n      isAdmin\n    }\n  }\n"];

export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> = TDocumentNode extends DocumentNode<  infer TType,  any>  ? TType  : never;