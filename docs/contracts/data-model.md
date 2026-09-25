# Data model — `router-api` TypeORM entities

PostgreSQL in production, SQLite in dev/test (portable column types only: `uuid` as `varchar(36)` under
SQLite via a shared column helper, `bigint` stored as string, JSON as `simple-json`). Schema changes go
through TypeORM migrations (`apps/router-api/src/migrations`, runner in the release image — SUP-83).
Auth tables (`user`, `session`, `account`, `verification`) are owned by Better Auth (ADR-004).

| Entity | Table | Purpose |
| --- | --- | --- |
| `User` | `user` (Better Auth) | read-only mapping: `id`, `email`, `name`, `image`, `createdAt` |
| `Workspace` | `workspaces` | billing/tenancy unit; `id`, `name`, `slug` (unique), `balanceMicros` (bigint cache), `stripeCustomerId?`, `autoTopUpEnabled`, `autoTopUpThresholdMicros?`, `autoTopUpAmountMicros?`, `autoTopUpLastAt?`, `createdAt` |
| `WorkspaceMember` | `workspace_members` | `workspaceId`, `userId`, `role: owner\|member`; PK `(workspaceId,userId)` |
| `ApiKey` | `api_keys` | `id`, `workspaceId` (idx), `name`, `keyHash` (sha256, unique), `prefix` (12 chars, display), `modelScope: string[]\|null` (model ids; null = all), `spendLimitMicros?`, `spentTotalMicros` (bigint), `requestsPerMinute?`, `tokensPerMinute?`, `expiresAt?`, `lastUsedAt?`, `revokedAt?`, `createdByUserId`, `createdAt` |
| `Model` | `models` | **projection of router config**, upserted at boot: `id` (= slug, PK), `name`, `litellmModel`, `endpointId`, `contextLength`, `capabilities: string[]`, `promptPer1mMicros`, `completionPer1mMicros`, `tee`, `enabled`, `updatedAt`. Config is the source of truth; rows exist for FK integrity and history |
| `Endpoint` | `endpoints` | **projection of router config** (`endpoints[]`): `id` (uuid), `name` (unique), `hostname` (unique), `tee`, `evidenceUrl?`, `enabled`, `updatedAt` |
| `EvidenceSnapshot` | `evidence_snapshots` | what the platform published: `id`, `endpointId` (idx), `fetchedAt`, `issuedAt`, `evidenceDigest`, `evidenceDigestHex`, `certFingerprint`, `quoteFormat?`, `containerImages: string[]`, `chainSummary: JSON` (subject/issuer/notAfter/fingerprint per cert), `measurements: JSON?`, `jws` (text), `bundle: JSON` (raw); **unique** `(endpointId, evidenceDigest, certFingerprint, issuedAt)` — idempotent multi-replica polling; retention per `UserPreferences.evidenceRetentionDays` applies to `bundle`/`jws` blobs only, digests are kept |
| `Generation` | `generations` | metered request, **no content columns**: `id` (`gen-<ulid>`), `workspaceId` (idx), `apiKeyId?` (SET NULL), `modelId`, `endpointId`, `evidenceSnapshotId?` (fresh snapshot at request time; null = no coverage), `evidenceDigest?` (denormalised), `promptTokens`, `completionTokens`, `costMicros` (bigint), `promptPer1mMicros`, `completionPer1mMicros` (frozen prices), `streamed`, `status: ok\|error\|aborted`, `errorCode?`, `finishReason?`, `latencyMs`, `timeToFirstTokenMs?`, `tokensPerSecond?`, `requestId?`, `clientIpHash?`, `createdAt` (idx with workspaceId) |
| `CreditTransaction` | `credit_transactions` | append-only ledger: `id`, `workspaceId` (idx), `kind: purchase\|usage\|refund\|adjustment\|auto_topup\|grant`, `amountMicros` (signed bigint), `reference?` (Stripe id / generation id), `description?`, `idempotencyKey` (unique), `createdAt`; a unit test asserts no `UPDATE`/`DELETE` path exists in the service |
| `InviteCode` | `invite_codes` | one mailed invitation: `id`, `code` (**normalised** — upper case, separators stripped — unique), `grantMicros` (bigint), `campaign` (idx), `maxRedemptions` (default 1), `redemptionCount`, `expiresAt?`, `disabledAt?`, `note?`, `createdAt`. Normalising on write and on lookup is what makes the match case-insensitive as a plain index hit; neither `citext` nor `COLLATE NOCASE` exists on both databases |
| `InviteRedemption` | `invite_redemptions` | that an account spent one, once and for all: `id`, `inviteCodeId` (idx, FK CASCADE), `userId` (**unique**), `workspaceId` (FK CASCADE), `creditTransactionId`, `ipHash?`, `userAgentHash?` (salted digests, never the values), `redeemedAt`. No FK on `userId` — Better Auth owns `user` (ADR-004 §3) |
| `FeedbackSubmission` | `feedback_submissions` | one verified feedback submission and the second grant it did or did not earn: `id`, `provider`, `formId?`, `submissionId` (**unique**), `userId` (idx), `workspaceId` (FK CASCADE), `grantedUserId?` (**unique**, set only when credited), `grantMicros?`, `creditTransactionId?`, `refusalReason?`, `answers: JSON`, `submittedAt`, `createdAt`. A refused submission is kept — the answers are what the grant buys — and leaves `grantedUserId` null, which a unique index ignores on both drivers. No FK on `userId` — Better Auth owns `user` (ADR-004 §3); the hidden token the form carried is **never** stored |
| `UserPreferences` | `user_preferences` | 1:1 with user: `userId` (PK), `archiveEvidence` (default true), `evidenceRetentionDays` (default 90), `notifyOnMeasurementChange` (default true), `desktopNotifications`, `emailReceipts`, `updatedAt` |
| `ActivityRollup` | `activity_rollups` | **derived**, hourly `(workspaceId, modelId, apiKeyId, bucket)` → `requests`, `promptTokens`, `completionTokens`, `costMicros`, `coveredRequests`; rebuildable. **Not written yet** (SUP-75): Activity aggregates in SQL over `generations`, which one indexed range scan answers, and a cache no screen needs is a second source of truth to keep correct. The table stays for the day a log outgrows the scan |

Relations: `InviteCode 1—* InviteRedemption`, `Workspace 1—* FeedbackSubmission`, `Workspace 1—* ApiKey`, `Workspace 1—* Generation`, `Workspace 1—* CreditTransaction`,
`Endpoint 1—* Model`, `Endpoint 1—* EvidenceSnapshot`, `Model 1—* Generation`, `ApiKey 1—* Generation`
(nullable), `EvidenceSnapshot 1—* Generation` (nullable), `User 1—1 UserPreferences`, `User *—*
Workspace` via `WorkspaceMember`.

Invariants enforced in code and tests:

1. `generations` has no column whose type can hold prompt/completion text (test walks entity metadata).
2. No table stores a verification verdict; `EvidenceSnapshot` has no boolean about validity.
3. `Workspace.balanceMicros == SUM(credit_transactions.amountMicros)` after every ledger write. Enforced
   in one transaction per entry that updates the balance *relatively*
   (`balanceMicros = balanceMicros + :delta`) and inserts the row: no read-modify-write means no lost
   update, and no `SELECT … FOR UPDATE` means the same code is correct on SQLite, which has neither row
   locks nor the syntax. The unique index on `idempotencyKey` is what makes a redelivered webhook or a
   retried debit collapse onto the existing row (`ledger.service.spec.ts`).
4. `Model`/`Endpoint` rows are never edited through the API; a config change re-projects them at boot
   (disabled rows are kept for history, `enabled = false`).
5. Deleting a user nulls `Generation.apiKeyId`/`createdByUserId` references; ledger rows are never deleted.
6. One invitation grant per account, ever. The unique index on `invite_redemptions.userId` **is** the
   policy; a composite unique on `(inviteCodeId, userId)` is deliberately absent because this one implies
   it. A seat is taken by one relative `UPDATE … WHERE redemptionCount < maxRedemptions AND disabledAt IS
   NULL AND (expiresAt IS NULL OR expiresAt > :now)`, in the same transaction as the `grant` ledger row and
   the redemption — so two sign-ups racing for the last seat resolve to exactly one grant without a row
   lock, which SQLite has not got. The ledger's `idempotencyKey` is `invite:<codeId>:<userId>`, which
   refuses a second credit even if the first two locks were bypassed (`invites.service.spec.ts`).
7. One **feedback** grant per account, ever, and one grant per submission however often the form provider
   redelivers it. Three locks again, all in the database: the unique `feedback_submissions.submissionId`
   (a redelivery settles onto the row the first delivery wrote), the unique *nullable*
   `feedback_submissions.grantedUserId` (the one-per-account policy — nullable so a refused submission can
   sit beside a credited one without the index calling them duplicates), and the ledger's
   `idempotencyKey`, `feedback:<userId>`. The credit and the submission row are written in one
   transaction (`feedback.service.spec.ts`, `feedback.e2e.spec.ts`).
