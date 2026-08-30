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
| `CreditTransaction` | `credit_transactions` | append-only ledger: `id`, `workspaceId` (idx), `kind: purchase\|usage\|refund\|adjustment\|auto_topup`, `amountMicros` (signed bigint), `reference?` (Stripe id / generation id), `description?`, `idempotencyKey` (unique), `createdAt`; a unit test asserts no `UPDATE`/`DELETE` path exists in the service |
| `UserPreferences` | `user_preferences` | 1:1 with user: `userId` (PK), `archiveEvidence` (default true), `evidenceRetentionDays` (default 90), `notifyOnMeasurementChange` (default true), `desktopNotifications`, `emailReceipts`, `updatedAt` |
| `ActivityRollup` | `activity_rollups` | **derived**, hourly `(workspaceId, modelId, apiKeyId, bucket)` → `requests`, `promptTokens`, `completionTokens`, `costMicros`, `coveredRequests`; maintained by a rollup job so Activity does not scan `generations`; rebuildable |

Relations: `Workspace 1—* ApiKey`, `Workspace 1—* Generation`, `Workspace 1—* CreditTransaction`,
`Endpoint 1—* Model`, `Endpoint 1—* EvidenceSnapshot`, `Model 1—* Generation`, `ApiKey 1—* Generation`
(nullable), `EvidenceSnapshot 1—* Generation` (nullable), `User 1—1 UserPreferences`, `User *—*
Workspace` via `WorkspaceMember`.

Invariants enforced in code and tests:

1. `generations` has no column whose type can hold prompt/completion text (test walks entity metadata).
2. No table stores a verification verdict; `EvidenceSnapshot` has no boolean about validity.
3. `Workspace.balanceMicros == SUM(credit_transactions.amountMicros)` after every ledger write
   (same transaction, `SELECT … FOR UPDATE` on the workspace row).
4. `Model`/`Endpoint` rows are never edited through the API; a config change re-projects them at boot
   (disabled rows are kept for history, `enabled = false`).
5. Deleting a user nulls `Generation.apiKeyId`/`createdByUserId` references; ledger rows are never deleted.
