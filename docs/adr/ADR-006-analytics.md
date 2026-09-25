# ADR-006 — Analytics: Plausible on the landing, PostHog EU behind our own server

- **Status:** Accepted
- **Date:** 2026-09-25
- **Decided by:** Denis (SUP-140, 2026-09-25 — tool choice and accounts). §3 and §4, the transport and
  the consent consequence that follows from it, are SUP-143's and are open to revision until SUP-145
  lands.

## Context

The launch mails invitation codes worth $100 and then has to answer one question: *which campaign
produced accounts that actually sent tokens?* Two surfaces have to be measured to answer it — a static
landing page on `router.superprotocol.com` and the console on `console.router.superprotocol.com`, with
`api.router.` serving requests from inside the confidential cluster — and they are different origins by
necessity, because a single hostname cannot split TLS between AKS and the enclave (SUP-140,
2026-09-26).

The constraint that shapes everything below is the product's own claim. This is an LLM router whose
pitch is that the operator cannot read your prompts. Any measurement that would embarrass that claim in
an enterprise security review costs more than the number it produces.

## Decision

### 1. Plausible for the landing page

Cookieless, ~1 KB, EU-hosted, aggregate-only, and self-hostable under AGPL if we later want it in our
own cluster. It answers what a launch mailing needs — visits, sources, UTM campaigns, goals — and
stores nothing on the visitor's device, so the landing needs no consent banner.

### 2. PostHog (EU cloud) for the console and the API

Funnels, retention and cohorts, which is what tells us whether an account that redeemed $100 ever sent
a token. Configured deliberately: **autocapture off, session recording off, heatmaps off**, GeoIP-based
IP discard on, `$ip: null` on every server-side capture, person properties an allow-list of two. The configuration is not a preference; a product
whose entire pitch is that your prompts are unreadable cannot ship a recorder that watches its own
console.

### 3. The console reaches PostHog only through `router-api`

No `posthog-js` in the console bundle, no request from a customer's browser to `posthog.com`.

- **Six of the eight console-side events are already server-side facts** — sign-up, redemption, key
  creation, first request, model request, feedback grant. `router-api` knows each of them at the moment
  it commits the row, with `posthog-node` and an idempotency `uuid` taken from that row.
- The remaining two (`signup_started`, `feedback_form_opened`) are posted by the browser to a
  first-party ingest on `router-api`, which validates the event name and every property against the
  taxonomy allow-list (`libs/types/src/analytics/events.ts`) and forwards it. A public ingest that did
  not allow-list would be a way to write arbitrary rows into our analytics.
- What this buys: the console's `connect-src` stays `'self'`, the answer to "what third parties does
  your console talk to?" is "none", the numbers are not subject to blocklists, and the ingest key never
  reaches a browser.
- What it costs: one small endpoint in SUP-145, and no client-side events beyond the two listed. That
  is the right trade — everything else worth counting is something the server commits anyway.

### 4. Nothing is stored on a visitor's device for analytics, so there is no consent banner

Plausible sets no cookie and writes no storage. The console writes none either, because there is no
third-party SDK in it to write one. Both tools therefore stay outside ePrivacy Art. 5(3) — which is
about storing or reading information on terminal equipment, not about processing per se — and the
processing itself runs on legitimate interest (GDPR Art. 6(1)(f)): aggregate product measurement, no
profiling, no advertising, no data sold or shared.

The price is paid honestly: **the landing visitor and the account that appears later are not linked.**
`signup_started` is captured anonymously with `$process_person_profile: false`, and the funnel is joined
on `campaign` — which arrives in the invitation URL, is stored on the redemption row, and is a property
on both halves. We lose per-visitor attribution and keep the number that matters, because the campaign
tag is what the mailing was segmented by in the first place.

This is a determination, not legal advice. It holds only while the configuration above holds: turning
on session recording, autocapture, or a browser SDK with persistence puts a banner back on the table,
and SUP-150 states the same facts on `/privacy`.

### 5. The database is the third source and the one we believe

`inviteCampaignStats` (SUP-142) answers issued → redeemed → activated from our own tables. Third-party
analytics answers what the visitor clicked; our tables answer whether it worked. The campaign report
joins the two, and where they disagree the database is right.

### 6. Rejected

- **Google Analytics** — consent banner, US transfer, and a tonal contradiction we would have to defend
  in every enterprise security review.
- **Yandex Metrica** — Russian jurisdiction and session recording. An immediate disqualifier for the
  international enterprise buyers this product targets, whatever its merits elsewhere.
- **PostHog on the landing too**, which would have made one cross-domain funnel possible — it needs a
  persistent browser identifier, which is the banner we just avoided, on the page the campaign lands on.
- **Self-hosting either tool for launch.** Both support it; neither is worth an operational commitment
  before we know the traffic. Plausible's AGPL build is the exit if the hosted plan stops fitting.

## Consequences

- The event names are a contract between two repositories:
  [`schemas/analytics-taxonomy.json`](../../schemas/analytics-taxonomy.json), readable form in
  [`docs/contracts/analytics-events.md`](../contracts/analytics-events.md), typed view in
  `libs/types/src/analytics/events.ts`, and a test that fails when the three disagree.
- `router-api` config gains `analytics.{enabled, posthog{projectKey, host, flushAt}}`, from
  `POSTHOG_PROJECT_KEY` / `POSTHOG_HOST` at deploy time. With no key configured, capture is a no-op —
  the compose demo and every e2e run must not post to a real project.
- Emission never blocks a request and never fails one: a capture is fire-and-forget behind the response,
  and an analytics outage is invisible to a user.
- The first-party ingest (`POST /v1/telemetry`, SUP-145) is unauthenticated for `signup_started` and
  session-authenticated for `feedback_form_opened`; both are rate-limited per IP and validated against
  the allow-list.
- SUP-150's `/privacy` page states: the two tools, what each collects, 12-month PostHog retention,
  legitimate interest, the sub-processor list, and that the console stores nothing on the device. The
  taxonomy is public, so the page can link the exact list of events.
- SUP-147 may proxy Plausible's script and beacon through the landing ingress to keep them first-party.
- Accounts, domain verification and the keys are Denis's; agents never hold the passwords.
