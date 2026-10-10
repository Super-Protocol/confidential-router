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
  id: ID!, name: String!, hostname: String!, tee: String!            # tee = operator-declared label from router config; surfaces show latestEvidence.tee
  latestEvidence: EvidenceSnapshot                                   # what the platform currently publishes (may be null)
  evidenceState: EvidenceState!                                      # PUBLISHED | STALE | NOT_PUBLISHED (freshness only)
  tokensRouted30d: Int!
}
enum EvidenceState { PUBLISHED STALE NOT_PUBLISHED }
type EvidenceSnapshot {
  id: ID!, endpointId: ID!, fetchedAt: DateTime!, issuedAt: DateTime!
  quoteAgeSeconds: Int!                                              # now − issuedAt, for "issued 4 min ago"
  evidenceDigest: String!, evidenceDigestHex: String!                 # canonical wire form + the hex the console shows
  certFingerprint: String!, certFingerprintHex: String!
  quoteFormat: String                                                # rootCaTeeQuote.format, e.g. intel-tdx-quote-v5
  tee: String                                                        # TEE the root cert's TeeEvidence branch names, e.g. "AMD SEV-SNP (Azure)"; read, never verified (SUP-270)
  containerImages: [String!]!
  chain: [CertSummary!]!                                             # subject / issuer / notAfter / sha256 per cert
  measurements: [Measurement!]!                                      # MRTD / RTMR* / GPU when present in the snapshot
  jws: String!                                                       # "Copy evidence JWS"
  bundle: JSON!                                                      # raw published bundle for export
}
type CertSummary { subject: String!, issuer: String!, notAfter: DateTime!, fingerprint: String!, fingerprintHex: String!, isRoot: Boolean! }
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

# ---------- invitations ----------

type InviteGrant {                      # the viewer's credit, or null
  creditTransactionId: ID!              # the `grant` ledger row it wrote
  grantMicros: String!
  campaign: String!
  redeemedAt: DateTime!
}

type InviteCampaignStats {              # auth.adminEmails only
  campaign: String!
  issued: Int!
  redeemed: Int!
  redemptionRate: Float!
  activated: Int!                       # redeemers that went on to send a request
  grantedMicros: String!
}

enum InviteRefusalReason { NOT_FOUND, EXPIRED, EXHAUSTED, DISABLED, ALREADY_REDEEMED, ERROR }
type InviteGrantStatus {
  grant: InviteGrant                    # null when nothing was credited
  reason: InviteRefusalReason           # null when the grant is this account's and the code matches it
}

type InviteWithdrawal {                 # auth.adminEmails only; the four numbers add up to `matched`
  target: String!                       # the code or campaign, echoed back normalised
  matched: Int!                         # 0 means there is no such code or campaign
  withdrawn: Int!
  alreadyWithdrawn: Int!                # left with their original timestamp
  spent: Int!                           # left in circulation — `unspentOnly` only
}

type InviteRestoration {                # auth.adminEmails only
  target: String!
  matched: Int!
  restored: Int!
  alreadyUsable: Int!                   # matched, but never withdrawn
}

# Query.inviteGrant: InviteGrant        # session; how the console confirms the credit landed
# Query.inviteGrantStatus(code: String): InviteGrantStatus!          # session; the post-sign-up screen
# Query.inviteCampaigns(campaign: String): [InviteCampaignStats!]!   # session + admin
input RestoreInviteCodesInput { code: String, campaign: String }
input DisableInviteCodesInput { code: String, campaign: String, unspentOnly: Boolean = false }

# Mutation.disableInviteCodes(input: DisableInviteCodesInput!): InviteWithdrawal!
# Mutation.restoreInviteCodes(input: RestoreInviteCodesInput!): InviteRestoration!   # both session + admin
#
# There is deliberately no redeem mutation: a code is spent inside account
# creation and nowhere else, so there is nothing here a client could replay.
# Minting was CLI-only until SUP-268; the admin Invitations section below now
# mints too, behind auth.adminEmails.
#
# The two operator mutations run the other way — they only ever *stop* credit —
# and they exist because a deployment whose cluster space is published has no
# `kubectl exec` to reach `invites disable` with (SUP-159). Exactly one of `code`
# and `campaign` is required; naming neither or both is a 400. Withdrawing is
# idempotent and **never touches a grant already made**: `disabledAt` is read when
# a seat is claimed and nowhere else, so balances, `credit_transactions` and
# `invite_redemptions` are untouched (`data-model.md` invariant 6).
#
# `inviteGrantStatus` takes the code because nothing persists a *refusal*: the
# redemption writes a row when it succeeds and deliberately nothing when it does
# not, so the browser that presented the code is the only thing that still knows
# which one it was. Unlike `GET /v1/invites/{code}`, it answers the typed reason —
# the caller holds a session and already holds the code, so there is nothing left
# to leak, and `ALREADY_REDEEMED` (this account has a grant already, from another
# code) is only answerable where the account is known. It spends the same
# `invites.lookupsPerMinute` budget as the public lookup, keyed by account.

# ---------- the admin Invitations section (SUP-268) — all session + admin ----------

enum InviteCodeStatus { ACTIVE, REDEEMED, EXPIRED, WITHDRAWN }   # WITHDRAWN wins; a spent code reads REDEEMED even once expired
enum SignUpOrigin { INVITE, BOOTSTRAP, OPEN }
type AdminInviteCode {
  id: ID!  code: String!  url: String!  campaign: String!  grantMicros: String!
  maxRedemptions: Int!  redemptionCount: Int!  status: InviteCodeStatus!
  createdAt: DateTime!  expiresAt: DateTime  withdrawnAt: DateTime  note: String
  issuedByEmail: String                 # null: minted by the CLI
  redeemers: [InviteCodeRedeemer!]!     # { userId, email, redeemedAt, carried }, oldest first; `carried` is a
                                        # redemption a CSV import brought from another deployment, and its
                                        # `userId` is null until that address has an account here (SUP-272)
}
type AdminSignUp {
  userId: ID!  email: String!  createdAt: DateTime!  origin: SignUpOrigin!
  inviteCodeId: ID  inviteCode: String  campaign: String  redeemedAt: DateTime   # set exactly when origin = INVITE
}
type InviteStatistics { totals: InviteTotals!  daily: [InviteDay!]!  campaigns: [InviteCampaignStats!]! }
# Query.adminInviteCodes(campaign, status, offset = 0, limit = 50 ≤ 200): AdminInviteCodePage!   { totalCount, nodes }
# Query.adminSignUps(origin, offset = 0, limit = 50 ≤ 200): AdminSignUpPage!
# Query.inviteStatistics(days = 30 ≤ 366): InviteStatistics!    # daily is every UTC day of the window, zeros included
# Mutation.issueInviteCodes(input: { count ≤ 1000, grantMicros ≤ $10,000, campaign (slug), maxRedemptions = 1,
#   expiresAt?, note? }): IssuedInviteCodes!                     # { campaign, grantMicros, expiresAt, codes { id code url } }
# Mutation.withdrawInviteCode(id: ID!): InviteWithdrawal!        # unspent only, by row id — the code never travels back
#
# BOOTSTRAP is derived, not stored: `/auth/bootstrap` only ever creates the first
# account, under `auth.bootstrapEmail`, so it is the earliest account iff it has
# that address. Codes are answered in full (issuing them is the section's job);
# the console masks them until revealed, and no resolver logs one.

# ---------- the second grant, for feedback ----------

type FeedbackGrant {                    # the viewer's second credit, or null
  creditTransactionId: ID!              # the `grant` ledger row it wrote
  grantMicros: String!
  appliedAt: DateTime!
}

enum FeedbackIneligibleReason { disabled no_first_grant already_granted balance_healthy no_usage }

type FeedbackOffer {
  eligible: Boolean!
  reason: FeedbackIneligibleReason      # null when eligible
  grantMicros: String!
  formUrl: String                       # null unless eligible; carries a token good for minutes
  granted: FeedbackGrant
}

# Query.feedbackOffer: FeedbackOffer!   # session; takes no arguments on purpose
#
# Eligibility is the server's answer, never the browser's arithmetic: the console
# has the balance in hand and could guess, but a grant a tab can decide is a grant
# anyone can decide. Reading this query is what mints the token in `formUrl`, so it
# is scoped to the session and names no account of its own.
#
# There is no mutation here either. The grant is applied by the signed webhook and
# nowhere else (`POST /v1/webhooks/typeform`).

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
  `spendable`, `minTopUpMicros`, `maxTopUpMicros`, `purchasesAvailable` and the automatic top-up settings,
  and one query is one round trip. `purchasesAvailable` is false on a deployment that sells no credit, and
  the screen hides its buy panel rather than offering a button that can only fail (SUP-167).
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
  - `GET /admin/invite-codes/export.csv?campaign=&status=` — session cookie + `auth.adminEmails`; the
    Codes tab as a file, same two filters (`status` lower-case), full code values. Its counterpart
    `POST /admin/invite-codes/import[?apply=true&expect=<sha256>]` takes that file as a `text/csv` body
    and answers a JSON report; see `router.md`, "Moving codes between deployments" (SUP-272);
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
- **`signInOptions`** — new (SUP-95), and public, like `models`. Which sign-in paths this deployment
  offers: `bootstrap`, `github`, `google`, `magicLink`, `password` (SUP-112), plus `passwordMinLength`.
  The console asks before it has a session, so it can render only the paths that can work — a deployment
  with no OAuth app and no mailer would otherwise show two buttons and a form that all end in an error.
  `bootstrap` is the only one that is not configuration alone: it is true while `auth.bootstrapToken` is
  set *and* the deployment has no user, which is the window `POST /auth/bootstrap` is open in. Neither the
  token nor any password is ever reported; `passwordMinLength` is a rule, not a secret, and reporting it
  is what keeps the sign-up form from advertising a floor the router refuses.
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
| 503 | `SERVICE_UNAVAILABLE` |
| anything else | `INTERNAL_SERVER_ERROR` |

`extensions.status` carries the HTTP status alongside it. Apollo's own pre-resolution codes
(`GRAPHQL_VALIDATION_FAILED`, `GRAPHQL_PARSE_FAILED`, …) are kept as they are. With
`graphql.introspection` off — the production default — an `INTERNAL_SERVER_ERROR` loses its message and
its stack trace.

`503` is mapped because one refusal is policy rather than a fault (SUP-171): on a deployment with
`billing.provider: disabled`, `createCheckout` answers `SERVICE_UNAVAILABLE` with *"Buying credits is
switched off on this deployment."* — a sentence a client may quote. It was the only 5xx the router raises
deliberately, and while it was unmapped the console saw `INTERNAL_SERVER_ERROR` / *"Internal server
error."* and could not tell a deliberate refusal from an outage.

### Screen → operations, as shipped

**Sign in** `signInOptions` (public); **Overview** `activitySummary + endpoints + creditBalance`; **Models**
`models` (public) `+ endpoints`;
**Evidence modal** `endpoint.latestEvidence` / `evidenceSnapshots` / `evidenceDigestHistory` +
`refreshEvidence`; **API Keys** `apiKeys` + `createApiKey` / `updateApiKey` / `revokeApiKey`; **Activity**
`activitySummary` / `activitySeries` / `topKeys` / `usageByModel`; **Logs** `generations` (+ the CSV
download); **Credits** `creditBalance` / `creditTransactions` / `createCheckout` / `setAutoTopUp`;
**Gatekeeper** `gatekeeperRelease`; **Chat** `chatSettings` (public) `+ models` `+ chatThreads` / `chatThread` `+ chatCredential` / `createChatThread` / `setChatThreadModel` / `appendChatMessage` / `deleteChatThread`; **Profile** `me` (with `createdAt`) `+ activitySeries` /
`usageByModel` / `signedResponseDays` + `updateProfile`; **Preferences** `me { preferences }` +
`updatePreferences` / `exportEvidence`;
**Admin — external endpoints** `externalEndpoints` / `externalEndpoint` / `discoverExternalModels` `+
registerExternalEndpoint` / `updateExternalEndpoint` / `setExternalEndpointEnabled` / `rotateExternalEndpointKey`;
**Admin — trust list** `trustedMeasurements` `+ addTrustedMeasurement` / `updateTrustedMeasurement` /
`removeTrustedMeasurement`.

The two Admin reads are session-scoped and the mutations are not: every screen in the nav is reachable
by any signed-in member, and the Admin entry is reachable by one in `auth.adminEmails` — `me { isAdmin }`
is what the browser gates it on. The reads being wider than the nav entry is deliberate (ruling 3, ADR-008
§7), and the API is where it is enforced; the nav is sidebar hygiene.

## As shipped (SUP-180) — the console chat

Two operations, and deliberately nothing else. The chat's messages do not cross this schema: they go to
`POST /v1/chat/completions` with the key `chatCredential` mints, like any other client (ADR-007).

```graphql
enum ChatHistoryStorage { BROWSER_LOCAL ATTESTED_SERVER }

type ChatSettings {
  enabled: Boolean!
  maxMessageChars: Int!
  maxThreads: Int!
  maxMessagesPerThread: Int!
  historyStorage: ChatHistoryStorage!
  chatModelIds: [String!]!
}

type ChatCredential {
  apiKeyId: ID!
  secret: String!
  expiresAt: DateTime!
  baseUrl: String!
  modelScope: [String!]!
}

type ChatMessage {
  id: ID!
  role: ChatRole!
  "The one documented exception to \"no request content is stored\" (ADR-007 §4)."
  content: String!
  "The gateway's refusal for a turn that ended badly. A failed turn stays in the transcript."
  error: String
  createdAt: DateTime!
}

type ChatThread {
  id: ID!
  title: String!
  modelId: String!
  createdAt: DateTime!
  updatedAt: DateTime!
  "Oldest first. Empty on the thread list, which asks for titles only."
  messages: [ChatMessage!]!
}

extend type Query {
  "Public: the screen needs the limits before a session exists, and none of them is a fact about a viewer."
  chatSettings: ChatSettings!
  "This member's conversations in the workspace, most recently used first."
  chatThreads(workspaceId: ID!): [ChatThread!]!
  chatThread(workspaceId: ID!, threadId: ID!): ChatThread!
}

extend type Mutation {
  "Rotates: this user's own live console_chat key in the workspace is revoked first, and no one else's."
  chatCredential(input: ChatCredentialInput!): ChatCredential!

  createChatThread(input: CreateChatThreadInput!): ChatThread!
  setChatThreadModel(input: CreateChatThreadInput!, threadId: ID!): ChatThread!
  "Records a turn that has already happened. This does not call a model."
  appendChatMessage(input: AppendChatMessageInput!): ChatMessage!
  deleteChatThread(workspaceId: ID!, threadId: ID!): Boolean!
}
```

`historyStorage` exists so the console does not decide for itself what it may promise. Every deployment
now answers `ATTESTED_SERVER`: threads live in `chat_threads` / `chat_messages` inside the attested
boundary, encrypted at rest by the in-TEE LUKS disk. That value licenses a *confidentiality* claim and
emphatically not a durability one — the state disk is ephemeral by design, the durability work was
deferred and the risk accepted (2026-09-30), and every surface that mentions storage says so in the same
breath. `BROWSER_LOCAL` stays in the enum as the honest answer for a deployment with no such storage.

**There is no `sendMessage`, and there will not be.** `appendChatMessage` *records* a turn that has
already happened; the browser calls the model itself over `/v1/chat/completions`. That is what keeps the
metering invariant intact: a mutation that called a model would be a second inference path and would put
prompt text on the surface `generations` is guarded to keep clean. The console calls it twice per
exchange — the question when it is sent, the answer when the stream settles — so a tab that dies
mid-answer leaves the question in the transcript rather than losing the turn.

`maxMessageChars` is enforced on the way in, and not identically for the two roles (SUP-187). A `USER`
turn over the ceiling is refused — the console stores the question before it calls a model, so that
refusal costs nothing. An `ASSISTANT` turn over the ceiling has already been streamed and metered, so it
is stored cut to the ceiling with the cut recorded in `error`; the console drops errored turns from the
next prompt, so a shortened answer is never replayed as though it were whole.

**A corollary worth stating plainly: a client can store an `ASSISTANT` turn the model never produced.**
That follows from recording rather than attesting, and it is by design. The router does not witness the
exchange — that is the whole point of the browser calling `/v1` itself — so it cannot distinguish a
model's answer from a string the caller typed. The reason this costs nothing is who can read the result:
a transcript is scoped to `(workspace, member)`, so the only person a forged turn can mislead is the
person who wrote it. Nothing downstream treats these rows as evidence of anything — they are not
metering, not billing, not attestation, and never leave the boundary. If a surface ever wants a
transcript it can *trust*, the metering record (`generations`) is the witnessed one, and it deliberately
holds no content.

`chatCredential` is a real `/v1` credential reaching a browser, so it is scoped to the chat-capable
catalogue and expires in `chat.credentialTtl` (default 2 h). It is never returned twice: asking again
mints a new key and revokes the previous one, because the plaintext of that one was shown once.

Rotation is narrowed to `(workspaceId, createdByUserId)`. A workspace has members, and revoking every
`console_chat` key in it would mean one member opening the chat breaking the tab another member has
open until their cached secret expired. Clients should still treat a `401` of code `api_key_revoked`,
`api_key_expired` or `invalid_api_key` as "mint again and retry once" — that is what the console does,
and it is the only reason a caller needs to read those codes.

## As shipped (SUP-225, SUP-226) — the admin section

The external-endpoint control plane (ADR-008 §7), split across two issues that code against this
block and nothing else: **SUP-225** implemented the resolvers in router-api, **SUP-226** the console
screens. Both have landed, so the SDL below is now in the committed
[`apps/router-api/schema.graphql`](../../apps/router-api/schema.graphql) and that file is what
router-ui's codegen reads. The overlay the console was built against while the resolvers were in
flight is gone with it; `apps/router-ui/src/components/admin/schema-contract.spec.ts` keeps the two
guards that are about the schema rather than about the overlay — the external vocabulary never
collapses into the own-endpoint one, and nothing readable can carry the upstream key (threat T15).
A contract change still lands **here first**, and both sides follow; SUP-237 is the standing
document-↔-schema conformance check that will hold that rule mechanically.

Three decisions in this block are worth reading before the SDL:

1. **The vocabulary names the verifying party.** ADR-002 keeps *published / fresh / stale* for the
   router's own endpoints because it never verifies itself. An external upstream is the mirror case —
   there is a verifier, and it is this router — so the enum says `VERIFIED_BY_THIS_ROUTER` /
   `DENIED_BY_THIS_ROUTER` and never a bare `verified` (ADR-008 §1).
2. **`ExternalEndpointEvidence` is what a pinned digest stands for** (SUP-221 ruling 1, as amended by
   SUP-252). Admission was first the measurement check alone, which admits a *cloud* and cannot see
   which deployment on it answered (threat T13); it is now two-factor — the measurement *and* the
   evidence digest an admin pinned for the endpoint — and this summary is what the admin reads before
   pinning. The console renders the upstream's workloads and image digests for every registered
   endpoint, before every approval and on every change — `ExternalEndpointEvent.evidence` is what makes
   "on every change" a field rather than a convention. See [As shipped (SUP-252)](#as-shipped-sup-252--two-factor-endpoint-trust).
3. **The two reads are session-scoped, not admin-scoped** (ruling 3, ADR-008 §7). A non-admin gets the
   same rows with `apiKeyPrefix` and `upstreamModel` null; every mutation is `AdminGuard`. The nav
   entry is admin-only, which is sidebar hygiene and not the access control.

`me { isAdmin }` is new and is the only thing the browser gates on. The connection-link fast path the
register dialog accepts has its own contract: [`connection-link.md`](./connection-link.md), with
shared vectors in [`connection-link-vectors.json`](./connection-link-vectors.json).

```graphql
"""
Where an external upstream stands with the verification *this router* performed.

Deliberately not the own-endpoint vocabulary (`EvidenceState`: published / stale
/ not published). That one is a statement about publication because the router
never verifies itself (ADR-002); here there *is* a verifying party, so every
value names it (ADR-008 §1).
"""
enum ExternalEndpointStatus {
  """
  Registered, no verdict read back yet. Serves nothing (ADR-008 §8).
  """
  PENDING
  VERIFIED_BY_THIS_ROUTER
  DENIED_BY_THIS_ROUTER
  """
  The operator's own switch — not a verdict.
  """
  DISABLED
}

"""
Which anchor vouched for the measurement the verdict saw (SUP-139).
"""
enum MeasurementSource {
  REGISTRY
  OPERATOR_PINNED
}

"""
The timeline's events. `VERIFIED_BY_THIS_ROUTER` / `DENIED_BY_THIS_ROUTER` rather
than a bare `VERIFIED` / `DENIED` for the same reason as `ExternalEndpointStatus`:
the vocabulary rule is absolute, and a timeline entry is exactly where a reader
would otherwise lose track of who reached the verdict.
"""
enum ExternalEndpointEventKind {
  REGISTERED
  VERIFIED_BY_THIS_ROUTER
  DENIED_BY_THIS_ROUTER
  DIGEST_CHANGED
  MEASUREMENT_CHANGED
  DISABLED
  KEY_ROTATED
}

"""
One Kubernetes workload of the upstream's canonical snapshot.
"""
type EvidenceWorkload {
  kind: String!
  name: String!
  namespace: String
  containers: [String!]!
}

"""
What a cloud-level admission actually let in: the upstream's workloads and image
digests. Informational, never gating (SUP-221 ruling 1) — admission is the
measurement check in ADR-008 §3 and nothing here.
"""
type ExternalEndpointEvidence {
  snapshotId: ID!
  fetchedAt: DateTime!
  issuedAt: DateTime!
  evidenceDigest: String!
  evidenceDigestHex: String!
  certFingerprint: String!
  certFingerprintHex: String!
  quoteFormat: String
  """
  Enclave image digests from the upstream's canonical snapshot.
  """
  containerImages: [String!]!
  workloads: [EvidenceWorkload!]!
  measurements: [Measurement!]!
}

"""
One entry of an external endpoint's verdict timeline. History, never input: a
past `VERIFIED_BY_THIS_ROUTER` is not current trust (ADR-008 §8).
"""
type ExternalEndpointEvent {
  id: ID!
  at: DateTime!
  kind: ExternalEndpointEventKind!
  """
  ADR-003 §1 pipeline stage of a refusal: fetch, cert-chain, untrusted-root, jws, tls-fingerprint, policy.
  """
  stage: String
  reason: String
  measurement: String
  evidenceDigest: String
  """
  `evidenceDigest` as 64 hex characters — the spelling every screen shows (SUP-115).
  """
  evidenceDigestHex: String
  """
  The evidence summary in force at this event, so ruling 1's "at registration and
  on every change" is literally what the timeline renders. Null when no snapshot
  was stored for it.
  """
  evidence: ExternalEndpointEvidence
}

type ExternalEndpointModel {
  id: ID!
  name: String!
  """
  The name the upstream knows it by. Admin only — null for a non-admin reader.
  """
  upstreamModel: String
  contextLength: Int!
  pricing: Pricing!
  capabilities: [ModelCapability!]!
}

"""
A model endpoint in another deployment, registered at runtime by an admin and
attested by this router before any prompt is proxied (ADR-008).
"""
type ExternalEndpoint {
  id: ID!
  """
  Immutable after registration: it is also the sidecar's endpoint key.
  """
  name: String!
  baseUrl: String!
  hostname: String!
  enabled: Boolean!
  status: ExternalEndpointStatus!
  lastCheckedAt: DateTime
  lastStage: String
  lastReason: String
  """
  Normalised mrEnclave hex of the upstream cloud's root, as the verdict observed it.
  """
  measurementSeen: String
  measurementSource: MeasurementSource
  evidenceDigestSeen: String
  """
  The TLS leaf egress is pinned to; no CA bundle is consulted.
  """
  pinnedCertFingerprint: String
  """
  Leading characters of the upstream API key, so the console can identify a
  credential it can never read. Admin only — null for a non-admin reader.
  """
  apiKeyPrefix: String
  models: [ExternalEndpointModel!]!
  """
  Most recent first.
  """
  events: [ExternalEndpointEvent!]!
  latestEvidence: ExternalEndpointEvidence
  createdAt: DateTime!
  updatedAt: DateTime!
}

"""
One VM launch measurement this deployment accepts for an external upstream — the
admin trust list, and the sole authority on admission (ADR-008 §3).
"""
type TrustedMeasurement {
  id: ID!
  measurement: String!
  note: String
  addedByEmail: String
  addedAt: DateTime!
  """
  Registered endpoints this row currently admits — what removing it would drop.
  Computed from the measurement each endpoint's last verdict saw, so it is a
  statement about the last check and not a promise about the next one.
  """
  admits: Int!
}

input ExternalModelInput {
  id: String!
  name: String!
  upstreamModel: String!
  contextLength: Int!
  promptPer1mMicros: String!
  completionPer1mMicros: String!
  capabilities: [ModelCapability!]
}

input RegisterExternalEndpointInput {
  name: String!
  baseUrl: String!
  """
  The upstream's ordinary LLM API key (decision 3). Write-only: no read path returns it.
  """
  apiKey: String!
  models: [ExternalModelInput!]!
}

"""
`name` is absent on purpose — see `ExternalEndpoint.name`.
"""
input UpdateExternalEndpointInput {
  baseUrl: String
  models: [ExternalModelInput!]
}

input SetExternalEndpointEnabledInput {
  enabled: Boolean!
}

input RotateExternalEndpointKeyInput {
  apiKey: String!
}

input AddTrustedMeasurementInput {
  measurement: String!
  note: String
}

extend type User {
  """
  Whether this account is in `auth.adminEmails`. Nothing in the browser could
  know before (`viewer.model.ts`), so the admin nav entry had nothing to gate on.
  """
  isAdmin: Boolean!
}

extend type Query {
  """
  Session, not admin: an operator curating external capacity in secret is the
  configuration this product should make impossible to sell as confidential
  (ADR-008 §7, ruling 3). A non-admin reader gets the same rows with
  `apiKeyPrefix` and `upstreamModel` null.
  """
  externalEndpoints: [ExternalEndpoint!]!
  externalEndpoint(id: ID!): ExternalEndpoint
  """
  Session, not admin — same reason.
  """
  trustedMeasurements: [TrustedMeasurement!]!
}

extend type Mutation {
  registerExternalEndpoint(input: RegisterExternalEndpointInput!): ExternalEndpoint!
  updateExternalEndpoint(id: ID!, input: UpdateExternalEndpointInput!): ExternalEndpoint!
  setExternalEndpointEnabled(id: ID!, input: SetExternalEndpointEnabledInput!): ExternalEndpoint!
  rotateExternalEndpointKey(id: ID!, input: RotateExternalEndpointKeyInput!): ExternalEndpoint!
  addTrustedMeasurement(input: AddTrustedMeasurementInput!): TrustedMeasurement!
  """
  Takes effect on the next check, and drops every endpoint it was admitting.
  """
  removeTrustedMeasurement(id: ID!): Boolean!
}
```

## As shipped (SUP-252) — two-factor endpoint trust

Denis's design change superseding ADR-008 §10 ruling 1: an external endpoint is
`VERIFIED_BY_THIS_ROUTER` only while its cloud's launch measurement is on the trust list **and** the
evidence digest it publishes equals the one an admin pinned for it. The additions to the block above:

- **`ExternalEndpoint.pinnedEvidenceDigest`** (+ `…Hex`) — the approved deployment, readable by any
  signed-in user (ruling 3). Null means nothing is approved yet: the endpoint stays `PENDING` with
  `lastStage: digest-not-pinned`. **`pinnedEvidence`** is the summary behind it, for the old-vs-new
  diff. **`evidenceDigestSeenHex`** is the spelling every screen shows and copies (SUP-115).
- **`lastStage`** gains the three factor codes the sidecar reports for a built-in two-factor denial:
  `digest-not-pinned` (`PENDING` — waiting for an approval, not a refusal), `measurement-not-trusted`
  and `digest-mismatch` (both `DENIED_BY_THIS_ROUTER`; the latter is a redeploy nobody approved, and
  fails closed — models dropped, in-flight connections closed).
- **`DIGEST_PINNED`** joins the event kinds (carrying the digest approved); **`DIGEST_CHANGED`** is now
  gating — on an admitted endpoint it arrives with the denial a mismatched pin causes.
- **`latestEvidence`** is filed whenever the last report's cryptography held, admitted or refused only by
  a trust factor, so the summary exists *before* the approval it informs.
- **`pinExternalEndpointDigest`** — `AdminGuard`, one input object like every mutation here. Accepts
  `sha256:<hex>` or `sha256/<base64url>`, stores the canonical form, replaces any earlier pin (approving
  a redeploy is this call with the new digest), records `DIGEST_PINNED`, writes a WARN naming the
  operator, and re-renders the sidecar config so the endpoint is re-checked at once.

```graphql
enum ExternalEndpointEventKind {
  # …as above, plus:
  DIGEST_PINNED
}

extend type ExternalEndpoint {
  evidenceDigestSeenHex: String
  pinnedEvidenceDigest: String
  pinnedEvidenceDigestHex: String
  pinnedEvidence: ExternalEndpointEvidence
}

input PinExternalEndpointDigestInput {
  evidenceDigest: String!
}

extend type Mutation {
  pinExternalEndpointDigest(id: ID!, input: PinExternalEndpointDigestInput!): ExternalEndpoint!
}
```

The console's dossier (`apps/router-ui/src/components/admin/trust-factors.tsx`) is the
TOFU-with-approval loop: *Measurement seen* with the registry-signed badge and "Add to trust list"
(`addTrustedMeasurement`), *Digest seen* with "Pin this digest"; after a redeploy, the approved and the
new digest with the evidence diff and "Approve new digest". The register dialog shows the same two
approvals in the stage that waits for them.

## As shipped (SUP-249) — model discovery, attest-then-list

The register dialog's primary path is now *paste a URL and a key*, not *type every model*. The
order is the point: the endpoint is registered with `models: []` (which `RegisterExternalEndpointInput`
already allowed), the egress sidecar attests it like any other, and only once the row says
`VERIFIED_BY_THIS_ROUTER` does the API make its first request upstream — `GET /v1/models` through the
endpoint's attested, certificate-pinned loopback listener, with the stored key injected by router-api.
An endpoint that is not verified is refused with `CONFLICT` and nothing is sent; a sidecar that
withdrew its verdict in the meantime answers its fail-closed 503, which comes back as a `CONFLICT`
naming the stage and reason. The admin ticks models and sets prices; the result is registered with
the ordinary `updateExternalEndpoint`, so there is no second write path.

```graphql
"""
One model an attested upstream lists on its own GET /v1/models. Hints only — the operator chooses
the public id, the name and the prices when registering it.
"""
type DiscoveredExternalModel {
  upstreamModel: String!
  name: String
  contextLength: Int
  "Micro-USD per 1M tokens, when the upstream publishes a price (another router does)."
  promptPer1mMicros: String
  completionPer1mMicros: String
  "The public model id this endpoint already publishes it under, or null."
  registeredAs: String
}

extend type Query {
  """
  Admin, not session: the call spends the stored upstream key. Read-only — it writes no row.
  """
  discoverExternalModels(id: ID!): [DiscoveredExternalModel!]!
}
```

The hints are read leniently from the fields the upstreams we know of publish — `context_length` and
`pricing.*_per_1m_micros` (another Confidential Router), `max_model_len` (vLLM). The body is read up to
2 MB and the list capped at 100 entries: it is another operator's answer, and it does not get to size
this process's memory. A `401`/`403` is reported as a refused key, a `404`/`405` as an upstream without a
model list (the dialog offers to type the models instead), and a stored key this deployment's
`CR_API_SECRETS_KEY` can no longer open as `SERVICE_UNAVAILABLE` — not as a network failure worth retrying.
The console's picker re-reads the endpoint's published models immediately before it writes, because
`updateExternalEndpoint` replaces the set and a model another admin published meanwhile must survive. A price hint is a starting point in the form; what this router charges stays
the operator's decision (decision 4). The connection link remains the one-paste fast path; the
dialog tells the two apart by shape (`apps/router-ui/src/lib/endpoint-source.ts`).

## As shipped (SUP-227) — external models on the public catalogue

The user-facing half of ADR-008 §7. The admin section above is where an external endpoint is
*managed*; this is where its models are *offered*, and the surface it changes is the one operation
in this schema that needs no session at all.

Three decisions, and the first two are schema changes to a type that was already public.

1. **One `models` list, with `origin` as the discriminator.** An external model is listed like any
   other — a catalogue that hid them would be a price list that misstates where inference happens.
   What must never be blended is the *attestation* a row carries, so that is enforced by
   nullability rather than by convention: a `CONFIG` row has `endpoint` and no `externalUpstream`,
   an `EXTERNAL` row the reverse. There is no value of `evidenceState` to read off an external row,
   so the console cannot mix the two vocabularies even by accident (ADR-008 §1).
2. **`Model.endpoint` and `Model.tee` are nullable now.** Both were non-null before ADR-008 and
   both are facts about *this* deployment: there is no `endpoints` row for someone else's
   deployment, this router publishes no evidence for its hostname, and nobody declares a TEE label
   for its hardware. A synthetic endpoint row would have carried an `evidenceState` about a hostname
   this deployment does not publish, which is exactly the blend decision 1 forbids; a relayed TEE
   label would have been this router asserting a fact it has no source for. A measurement admits a
   *cloud* and does not name its silicon.
3. **`Model.externalUpstream` is session-scoped, the whole field** (SUP-221 ruling 3). An anonymous
   caller gets name, price and `available` — no endpoint URLs and no verdict detail — and `null`
   rather than a populated object with nulls in it: "there is an upstream and here is nothing about
   it" is not a statement worth making, and `origin` already says the model is external.
   `available` exists so that the one fact ruling 3 does allow is a field of its own rather than
   something a reader derives from a `status` they cannot see.

`routerEndpoint` is the fourth change and the one that keeps the chat honest. The endpoint the
browser's TLS connection terminates at is always this router; for a built-in model that is also the
endpoint serving it, which is why the chat read it off the model until now. For an external model the
two come apart, so the gate reads `routerEndpoint` and the upstream's own evidence becomes a second,
separately labelled check (`ExternalInspectButton`). Verifying the upstream and unlocking the
composer on the result would gate a message on a document describing a connection the browser never
opens.

```graphql
"""
Where a listed model runs, and therefore which attestation applies to it.

CONFIG is declared in the router config and covered by the canonical snapshot a
user pins. EXTERNAL runs in another deployment, reached through this router's
attesting egress — the pin covers the verifier, not the upstream (ADR-008 §1).
"""
enum ModelOrigin {
  CONFIG
  EXTERNAL
}

"""
The deployment behind an external model, and where this router's verification of
it stands.

Deliberately smaller than `ExternalEndpoint`: no base URL, no key prefix, no
listen port. `name` is here because it is the key of the raw-bundle relay
(`GET /v1/evidence/{endpoint}`), which is how a browser reads the upstream's
published evidence and verifies it itself.
"""
type ExternalUpstream {
  id: ID!
  name: String!
  hostname: String!
  status: ExternalEndpointStatus!
  lastCheckedAt: DateTime
  measurementSeen: String
  evidenceDigestSeen: String
  """
  `evidenceDigestSeen` as 64 hex characters — the spelling every screen shows and
  copies (SUP-115); null when there is no digest or it does not parse.
  """
  evidenceDigestSeenHex: String
}

extend type Model {
  origin: ModelOrigin!
  """
  Whether this router will route to it right now. Always true for CONFIG; for
  EXTERNAL it is false unless the endpoint holds a live verdict admitting it
  (ADR-008 decision 5) — a denied upstream's models stay listed and unavailable,
  because a catalogue that dropped them would leave the external vocabulary with
  nothing to say "denied by this router" about.
  """
  available: Boolean!
  """Null for an EXTERNAL model. Read `externalUpstream` instead."""
  endpoint: Endpoint
  """Null for a CONFIG model, and null for an anonymous caller (ruling 3)."""
  externalUpstream: ExternalUpstream
  """Null for an EXTERNAL model: nobody declares one for another deployment."""
  tee: String
}

extend type Query {
  """
  The endpoint this deployment publishes evidence for — the one a browser's
  connection terminates at, and therefore the one a page can verify. Public, like
  `models`: the chat's tier-1 gate needs it before the composer will open, and
  `GET /v1/evidence` already serves this deployment's own bundle unauthenticated.
  Null when this router cannot tell which of its endpoints is its own
  (`EvidenceService.ownEndpoint` refuses to guess between two).
  """
  routerEndpoint: Endpoint
}
```

A `tee:` argument on `models` excludes every external model, which is the filter being honest rather
than losing rows: it narrows on an operator's declaration about this deployment's own hardware.

### Screen → operations, SUP-227

| Screen | Operations | Notes |
| --- | --- | --- |
| Models | `models` | One table. The origin badge comes from `origin`; the attestation column renders `EvidenceBadge` for a row with an `endpoint`, `ExternalAttestationBadge` for one with an `externalUpstream`, and `available` alone for an anonymous reader. The two badges share no component and no label. |
| Chat | `chatSettings`, `routerEndpoint`, `models` | `chatModelIds` contains an external model only while its endpoint holds a live admitting verdict, and is also the scope every chat credential is minted with — so the picker and the key cannot disagree. The gate runs on `routerEndpoint`; `externalUpstream` drives the second inspect panel. |
