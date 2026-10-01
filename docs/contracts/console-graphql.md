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
  evidenceDigest: String!, evidenceDigestHex: String!                 # canonical wire form + the hex the console shows
  certFingerprint: String!, certFingerprintHex: String!
  quoteFormat: String                                                # rootCaTeeQuote.format, e.g. intel-tdx-quote-v5
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
# There is deliberately no redeem mutation and no generate mutation: a code is
# spent inside account creation and nowhere else, and minting is a CLI behind an
# operator's database access, so there is nothing here a client could replay and
# nothing here that creates credit.
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
`updatePreferences` / `exportEvidence`.

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
