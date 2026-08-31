# Console GraphQL — schema outline

Served by `apps/router-api` at `/graphql` (Apollo, **code-first** NestJS resolvers).

**The shipped schema is [`apps/router-api/schema.graphql`](../../apps/router-api/schema.graphql).** It is
emitted from the resolvers, committed, and checked on every CI run against both the resolver metadata and
the schema the running application serves; `apps/router-ui` generates its Apollo client from that file
(never edit generated client code by hand). The SDL below is the *design target* this document has carried
since SUP-66 — where the two differ, the committed file wins and the difference is listed under "As
shipped" at the end. Auth: session cookie (ADR-004); every field is scoped to `viewer`'s workspaces. Money is an integer number of micro-USD
carried as a `String` (the shipped schema has no custom `Micros` scalar — a scalar that serialises to a
string buys nothing a described `String` does not, and costs every client a codegen mapping); every money
field is therefore named `…Micros`. A nullable money input sent as `null` means *no limit*, never zero,
and anything that is not a whole non-negative amount is a `400`, not a server error. IDs are UUIDs;
times are ISO-8601 `DateTime`.

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
  quoteAgeSeconds: Int!                                              # now − issuedAt, for "issued 4 min ago"
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

type EvidenceDigestChange { evidenceDigest: String!, evidenceDigestHex: String!, firstIssuedAt: DateTime!, lastIssuedAt: DateTime!, snapshots: Int! }
type EvidenceCoverage { requests: Int!, covered: Int!, ratio: Float! }

extend type Query {
  models(tee: String): [Model!]!
  model(id: ID!): Model
  endpoints(workspaceId: ID!): [Endpoint!]!
  evidenceSnapshots(endpointId: ID!, first: Int = 20, after: String): EvidenceSnapshotConnection!
  evidenceDigestHistory(endpointId: ID!, limit: Int = 20): [EvidenceDigestChange!]!   # when a pinned digest would have had to change
  evidenceCoverage(workspaceId: ID!, from: DateTime!, to: DateTime!, endpointId: ID): EvidenceCoverage!
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

## As shipped (SUP-75)

Activity, Logs, Credits and Preferences are implemented; the deltas from the SDL above are deliberate
and small:

- **Money fields** are `String` named `…Micros` (see above), and `Bucket`/`GenerationSortField` /
  `SortDirection` are enums on the query rather than free strings.
- **Cross-type references are ids plus a resolved name** — `Generation.modelId` + `modelName`,
  `KeyUsage.apiKeyId` + `name`, `ModelUsage.modelId` + `name` — because the `Model`, `Endpoint` and
  `ApiKey` object types land with SUP-73/SUP-74. Adding the object field later is additive; a name is
  what the Logs and Activity tables render today.
- **`creditBalance(workspaceId)`** replaces reading `workspace.balance`: the Credits screen also needs
  `spendable`, `minTopUpMicros` and the automatic top-up settings, and one query is one round trip.
- **Mutations take one input object** (`createCheckout(input:)`, `setAutoTopUp(input:)`) so the workspace
  id and the payload travel together — that pair is what the membership check reads.
- **`generations` gains `sort:`**, and `usageByModel` an optional `limit:` (which is the "top models by
  spend" list).
- **`activitySummary`/`activitySeries` also return `coveredRequests`**, so a client can render the ratio
  and its numerator without a second query.
- **Downloads are REST, not GraphQL**, because a download is a browser navigation with a filename and a
  content type:
  - `GET /activity/generations.csv?workspaceId=&from=&to=&modelIds=&apiKeyIds=&status=` — session
    cookie, same filters as `generations`, oldest first;
  - `GET /exports/evidence.zip?token=…` — the link `exportEvidence` mints. Signed with `auth.secret` and
    valid for 15 minutes, because the point of the export is that it can be handed to an auditor who has
    no console session. Membership is re-checked when the link is followed.
- **`updateProfile` and `deleteAccount`** are not implemented yet; they are account lifecycle rather than
  preferences.

Aggregates are computed in SQL over `generations` on every request. `activity_rollups` stays unwritten
until there is a workspace whose log is too large to scan: one source of truth is cheaper to keep correct
than a cache two screens can disagree with, and every query here is a prefix of
`IDX_generations_workspaceId_createdAt`.

Screen → operations: **Overview** `activitySummary + endpoints`; **Models** `models + endpoints`;
**Evidence modal** `endpoint.latestEvidence` / `evidenceSnapshots` + `refreshEvidence`; **API Keys**
`apiKeys` + mutations; **Activity** `activitySummary/activitySeries/topKeys/usageByModel`; **Logs**
`generations`; **Credits** `workspace.balance + creditTransactions + createCheckout + setAutoTopUp`;
**Profile** `viewer + activitySeries + usageByModel + signedResponseDays`; **Preferences**
`viewer.preferences + updatePreferences + exportEvidence`.

## As shipped (SUP-76)

SUP-76 consolidated the console API, emitted the schema and pointed the UI's codegen at it. On top of the
SUP-75 deltas above, these are the differences between this document's outline and the committed
`schema.graphql`:

- **`me`, not `viewer`, and no top-level `workspaces`/`workspace`.** The root field has been `me` since
  SUP-70 and every suite is written against it; renaming it would churn the whole API for a synonym.
  Memberships hang off it (`me { workspaces { … } }`) — the console needs identity and workspaces in the
  same round trip, and a second root field would be a second way to ask one question.
- **`User.avatarUrl`** (the contract's name) over Better Auth's `image`, and **`Workspace.balanceMicros`**
  over `balance`, keeping the `…Micros` rule that every money field follows.
- **`WorkspaceRole` is a real enum** (`OWNER` / `MEMBER`) rather than a string of the stored lower-case
  value, so a client cannot compare it against the wrong casing.
- **`User.preferences` replaces the top-level `preferences` query.** The Preferences screen loads in one
  query, and a setting has exactly one place it can be read from. `updatePreferences` stays a mutation.
- **`updateProfile(input: UpdateProfileInput!)`** takes an input object, like every other mutation here,
  and rejects a blank name. **`deleteAccount` is still not implemented**: deleting an account has to decide
  what happens to an append-only credits ledger and to generations other rows reference, and no ADR covers
  that yet.
- **`models` and `model` are the only public operations.** A router that meters LLM traffic has to be able
  to advertise its catalogue and its prices before anyone signs up. A signed-in caller gets their own
  `tokensRouted30d` on the same query; an anonymous one gets `0`, because there is no workspace to
  attribute usage to.
- **`gatekeeperRelease`** — new, and the Gatekeeper screen's only query. Version, notes URL, checksum
  manifest and one `GatekeeperDownload` per platform, read from GitHub Releases and cached
  (`gatekeeper.*` in the router config). `stale: true` means GitHub could not be reached and these are the
  last known links. It describes a published artefact: there is no registration, instance list or status,
  because the router never learns that a gatekeeper verified anything (ADR-002).

### Error codes

A GraphQL response is `200` whatever happened, so `extensions.code` is what a client branches on. Nest
exceptions are mapped in one place (`src/app/api/graphql/errors.ts`):

| status | `extensions.code` |
| --- | --- |
| 400 / 422 | `BAD_USER_INPUT` |
| 401 | `UNAUTHENTICATED` |
| 402 | `PAYMENT_REQUIRED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 429 | `TOO_MANY_REQUESTS` |
| anything else | `INTERNAL_SERVER_ERROR` |

`extensions.status` carries the HTTP status alongside it. Apollo's own pre-resolution codes
(`GRAPHQL_VALIDATION_FAILED`, `GRAPHQL_PARSE_FAILED`, …) are kept as they are. With
`graphql.introspection` off — the production default — an `INTERNAL_SERVER_ERROR` loses its message and
its stack trace.

### Screen → operations, as shipped

**Overview** `activitySummary + endpoints + creditBalance`; **Models** `models` (public) `+ endpoints`;
**Evidence modal** `endpoint.latestEvidence` / `evidenceSnapshots` / `evidenceDigestHistory` +
`refreshEvidence`; **API Keys** `apiKeys` + `createApiKey` / `updateApiKey` / `revokeApiKey`; **Activity**
`activitySummary` / `activitySeries` / `topKeys` / `usageByModel`; **Logs** `generations` (+ the CSV
download); **Credits** `creditBalance` / `creditTransactions` / `createCheckout` / `setAutoTopUp`;
**Gatekeeper** `gatekeeperRelease`; **Profile** `me` (with `createdAt`) `+ activitySeries` /
`usageByModel` / `signedResponseDays` + `updateProfile`; **Preferences** `me { preferences }` +
`updatePreferences` / `exportEvidence`.
