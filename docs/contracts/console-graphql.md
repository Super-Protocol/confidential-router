# Console GraphQL — schema outline

Served by `apps/router-api` at `/graphql` (Apollo, **code-first** NestJS resolvers). This SDL is the
target the code-first types must produce; SUP-76 commits the generated `schema.graphql` and
`apps/router-ui` runs GraphQL codegen against it (never edit generated client code by hand). Auth: session
cookie (ADR-004); every field is scoped to `viewer`'s workspaces. Money is `Micros` (string of integer
micro-USD); IDs are UUIDs; times are ISO-8601 `DateTime`.

Vocabulary rule (ADR-002): evidence fields say *published / fresh / stale* — there is no `verified`
field anywhere in this schema.

```graphql
scalar DateTime
scalar Micros      # integer micro-USD as string
scalar JSON

# ---------- viewer & workspace ----------
type User { id: ID!, email: String!, name: String, avatarUrl: String, createdAt: DateTime!, preferences: UserPreferences! }
type Workspace { id: ID!, name: String!, slug: String!, role: WorkspaceRole!, balance: Micros!, createdAt: DateTime! }
enum WorkspaceRole { OWNER MEMBER }

type Query {
  viewer: User!
  workspaces: [Workspace!]!
  workspace(id: ID!): Workspace!
}

# ---------- models & endpoints ----------
type Endpoint {
  id: ID!, name: String!, hostname: String!, tee: String!            # tee = operator-declared label from router config
  latestEvidence: EvidenceSnapshot                                   # what the platform currently publishes (may be null)
  evidenceState: EvidenceState!                                      # PUBLISHED | STALE | NOT_PUBLISHED (freshness only)
  tokensRouted30d: Int!
}
enum EvidenceState { PUBLISHED STALE NOT_PUBLISHED }
type EvidenceSnapshot {
  id: ID!, endpointId: ID!, fetchedAt: DateTime!, issuedAt: DateTime!
  evidenceDigest: String!, evidenceDigestHex: String!, certFingerprint: String!
  quoteFormat: String                                                # rootCaTeeQuote.format, e.g. intel-tdx-quote-v5
  containerImages: [String!]!
  chain: [CertSummary!]!                                             # subject / issuer / notAfter / sha256 per cert
  measurements: [Measurement!]!                                      # MRTD / RTMR* / GPU when present in the snapshot
  jws: String!                                                       # "Copy evidence JWS"
  bundle: JSON!                                                      # raw published bundle for export
}
type CertSummary { subject: String!, issuer: String!, notAfter: DateTime!, fingerprint: String!, isRoot: Boolean! }
type Measurement { name: String!, value: String! }
type Model {
  id: ID!, slug: String!, name: String!, contextLength: Int!, capabilities: [ModelCapability!]!
  pricing: Pricing!, endpoint: Endpoint!, tee: String!
}
enum ModelCapability { CHAT COMPLETIONS EMBEDDINGS }
type Pricing { promptPer1m: Micros!, completionPer1m: Micros! }

extend type Query {
  models(tee: String): [Model!]!
  model(id: ID!): Model
  endpoints(workspaceId: ID!): [Endpoint!]!
  evidenceSnapshots(endpointId: ID!, first: Int = 20, after: String): EvidenceSnapshotConnection!
}
extend type Mutation { refreshEvidence(endpointId: ID!): EvidenceSnapshot }   # "Fetch fresh quote" — re-poll only

# ---------- API keys ----------
type ApiKey {
  id: ID!, name: String!, prefix: String!, modelScope: [Model!]              # empty = all models
  spendLimit: Micros, spentTotal: Micros!, requestsPerMinute: Int, tokensPerMinute: Int
  expiresAt: DateTime, lastUsedAt: DateTime, revokedAt: DateTime, createdAt: DateTime!
}
type ApiKeyCreated { key: ApiKey!, secret: String! }                          # secret returned exactly once
input CreateApiKeyInput { workspaceId: ID!, name: String!, modelIds: [ID!], spendLimit: Micros, expiresAt: DateTime, requestsPerMinute: Int, tokensPerMinute: Int }
input UpdateApiKeyInput { name: String, modelIds: [ID!], spendLimit: Micros, expiresAt: DateTime, requestsPerMinute: Int, tokensPerMinute: Int }

extend type Query { apiKeys(workspaceId: ID!): [ApiKey!]! }
extend type Mutation {
  createApiKey(input: CreateApiKeyInput!): ApiKeyCreated!
  updateApiKey(id: ID!, input: UpdateApiKeyInput!): ApiKey!
  revokeApiKey(id: ID!): ApiKey!
}

# ---------- generations (Logs) ----------
type Generation {
  id: ID!, createdAt: DateTime!, model: Model!, endpoint: Endpoint!, apiKey: ApiKey
  promptTokens: Int!, completionTokens: Int!, cost: Micros!
  latencyMs: Int!, timeToFirstTokenMs: Int, tokensPerSecond: Float, streamed: Boolean!, finishReason: String
  evidenceSnapshot: EvidenceSnapshot                                  # snapshot fresh at generation time, or null
  status: GenerationStatus!                                           # OK | ERROR | ABORTED
}
enum GenerationStatus { OK ERROR ABORTED }
input GenerationFilter { from: DateTime, to: DateTime, modelIds: [ID!], apiKeyIds: [ID!], status: GenerationStatus }
extend type Query { generations(workspaceId: ID!, filter: GenerationFilter, first: Int = 50, after: String): GenerationConnection! }

# ---------- activity aggregates ----------
type ActivitySummary { spend: Micros!, requests: Int!, promptTokens: Int!, completionTokens: Int!, evidenceCoverage: Float!, avgTimeToFirstTokenMs: Int, avgTokensPerSecond: Float }
type ActivityPoint { bucket: DateTime!, spend: Micros!, requests: Int!, tokens: Int!, evidenceCoverage: Float! }
type KeyUsage { apiKey: ApiKey!, spend: Micros!, requests: Int! }
type ModelUsage { model: Model!, spend: Micros!, requests: Int!, tokens: Int! }
enum Bucket { HOUR DAY }
extend type Query {
  activitySummary(workspaceId: ID!, from: DateTime!, to: DateTime!): ActivitySummary!
  activitySeries(workspaceId: ID!, from: DateTime!, to: DateTime!, bucket: Bucket!): [ActivityPoint!]!
  topKeys(workspaceId: ID!, from: DateTime!, to: DateTime!, limit: Int = 5): [KeyUsage!]!
  usageByModel(workspaceId: ID!, from: DateTime!, to: DateTime!): [ModelUsage!]!
  signedResponseDays(workspaceId: ID!, days: Int = 365): [DateTime!]!   # Profile heatmap: days with ≥1 generation with evidence
}

# ---------- credits ----------
type CreditTransaction { id: ID!, createdAt: DateTime!, kind: CreditTransactionKind!, amount: Micros!, reference: String, description: String }
enum CreditTransactionKind { PURCHASE USAGE REFUND ADJUSTMENT AUTO_TOPUP }
type CheckoutSession { url: String! }
extend type Query { creditTransactions(workspaceId: ID!, first: Int = 20, after: String): CreditTransactionConnection! }
extend type Mutation {
  createCheckout(workspaceId: ID!, amount: Micros!): CheckoutSession!   # Stripe Checkout redirect
  setAutoTopUp(workspaceId: ID!, enabled: Boolean!, threshold: Micros, amount: Micros): Workspace!
}

# ---------- preferences ----------
type UserPreferences {
  archiveEvidence: Boolean!, evidenceRetentionDays: Int!, notifyOnMeasurementChange: Boolean!
  desktopNotifications: Boolean!, emailReceipts: Boolean!
}
input UpdatePreferencesInput { archiveEvidence: Boolean, evidenceRetentionDays: Int, notifyOnMeasurementChange: Boolean, desktopNotifications: Boolean, emailReceipts: Boolean }
type EvidenceExport { url: String!, expiresAt: DateTime! }
extend type Mutation {
  updatePreferences(input: UpdatePreferencesInput!): UserPreferences!
  exportEvidence(workspaceId: ID!, from: DateTime!, to: DateTime!): EvidenceExport!   # zip of bundles referenced by generations in the period
  updateProfile(name: String): User!
  deleteAccount: Boolean!
}

# ---------- connections (Relay-style, cursor = opaque) ----------
type PageInfo { hasNextPage: Boolean!, endCursor: String }
type GenerationConnection { edges: [GenerationEdge!]!, pageInfo: PageInfo!, totalCount: Int! }
type GenerationEdge { cursor: String!, node: Generation! }
type EvidenceSnapshotConnection { edges: [EvidenceSnapshotEdge!]!, pageInfo: PageInfo! }
type EvidenceSnapshotEdge { cursor: String!, node: EvidenceSnapshot! }
type CreditTransactionConnection { edges: [CreditTransactionEdge!]!, pageInfo: PageInfo!, totalCount: Int! }
type CreditTransactionEdge { cursor: String!, node: CreditTransaction! }
```

Screen → operations: **Overview** `activitySummary + endpoints`; **Models** `models + endpoints`;
**Evidence modal** `endpoint.latestEvidence` / `evidenceSnapshots` + `refreshEvidence`; **API Keys**
`apiKeys` + mutations; **Activity** `activitySummary/activitySeries/topKeys/usageByModel`; **Logs**
`generations`; **Credits** `workspace.balance + creditTransactions + createCheckout + setAutoTopUp`;
**Profile** `viewer + activitySeries + usageByModel + signedResponseDays`; **Preferences**
`viewer.preferences + updatePreferences + exportEvidence`.
