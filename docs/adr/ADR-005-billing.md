# ADR-005 — Billing: prepaid credits + Stripe

- **Status:** Accepted
- **Date:** 2026-08-30
- **Decided by:** Denis (decision 5)

## Context

The router meters tokens per API key and bills them from a balance, OpenRouter-style. The design's
Credits screen had a "Use crypto" toggle; Denis removed it — the first release takes cards only.

## Decision

1. **Prepaid credits, USD-denominated, integer micro-dollars.** Balance is never stored as a column; it is
   the sum of `CreditTransaction.amountMicros` per workspace, cached in `Workspace.balanceMicros` and
   recomputed by the ledger service inside the same DB transaction as every ledger insert. `bigint` in
   PostgreSQL, `string` in DTOs.
2. **Ledger, append-only.** `CreditTransaction{ kind: purchase | usage | refund | adjustment | auto_topup,
   amountMicros (signed), reference (Stripe id / generationId / admin note), idempotencyKey (unique) }`.
   Usage rows are written per generation at completion (`cost = inputTokens × inPricePer1M +
   outputTokens × outPricePer1M`, prices frozen on the `Generation` row).
3. **Admission:** a request is accepted when the workspace balance is positive and the key's own spend
   limit (if any) is not exhausted; a generation may overdraw by at most one response (we do not know the
   completion length up front). Negative balance blocks further requests with
   `402 insufficient_credits`.
4. **Provider behind an interface.** `PaymentProvider { createCheckout(workspace, amount) → url;
   handleWebhook(rawBody, sig) → LedgerEvent[]; chargeSaved(workspace, amount) }`. **Stripe** is the only
   implementation (existing account): Stripe Checkout Session (`mode: payment`) for top-ups, webhook
   `checkout.session.completed` credits the ledger with `idempotencyKey = stripe event id`; **auto top-up**
   stores the Stripe Customer + default payment method from the first checkout (`setup_future_usage:
   off_session`) and charges an off-session PaymentIntent when balance < `threshold`, at most once per
   `cooldown` (default 1 h) — `UserPreferences.autoTopUp{enabled, thresholdMicros, amountMicros}`.
5. **No crypto.** The "Use crypto" toggle is removed from the Credits screen; no on-chain ledger fields
   (`txHash`, token symbols) — unlike swarm-cloud's `TokenLedgerEntry`.
6. **Refunds/adjustments** are admin-only (`adjustment` rows via an operator CLI command, not the UI) in v1.

## Consequences

- `router-api` config: `billing.stripe.{secretKey, webhookSecret, priceCurrency}`, `billing.minTopUpMicros`
  (default $5), `billing.allowOverdraftMicros`.
- Webhook endpoint `POST /billing/stripe/webhook` verifies the Stripe signature on the raw body (NestJS
  `rawBody: true`), runs outside the GraphQL auth guard.
- Tests: ledger arithmetic and admission are pure unit tests; Stripe is exercised with a
  `FakePaymentProvider` in e2e; webhook signature verification has a fixture test.
- Pricing lives in router config (`models[].pricing`), not in the DB, so a price change is a deploy.
