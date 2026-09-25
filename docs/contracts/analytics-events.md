# Analytics event taxonomy

Every product event the two surfaces are allowed to emit, with the exact spelling each one uses. Two
repositories and two tools implement it — the landing page in
[`confidential-router-landing`](https://github.com/Super-Protocol/confidential-router-landing) through
Plausible, the console and API here through PostHog — so the names have to be settled before either
starts, or the funnels get stitched together afterwards by hand and the campaign report is an argument
about definitions.

- **The contract is [`schemas/analytics-taxonomy.json`](../../schemas/analytics-taxonomy.json).** This
  document is its readable form; where they disagree the JSON wins, and
  `libs/types/src/analytics/analytics.spec.ts` fails until they agree again.
- **Why these tools, and why the console makes no third-party requests:**
  [ADR-006](../adr/ADR-006-analytics.md).
- **What we actually decide from:** the database. `inviteCampaignStats` (SUP-142) answers *did the
  campaign produce accounts that send tokens* from our own tables. The tools answer *what did the
  visitor click*. When the two disagree, the database is right.

## Conventions

1. **`snake_case` everywhere**, events and properties alike, verb last (`cta_click`, not `click_cta`) so
   related events sort together. No surface prefixes: `signup_completed` is one event wherever it is read.
2. **Closed value sets by default.** An unbounded string property is a breakdown with one row per
   visitor. Adding a section to the page adds a value to `position` in the same pull request.
3. **Absent, never null.** An optional property is omitted when it does not apply. `null` and "missing"
   are two rows in every breakdown and mean the same thing.
4. **Scalars only.** No nested objects: they cannot be broken down on, and they are how free text gets in
   by accident.
5. **Money is integer micro-USD** (`grant_micros`), matching ADR-005 and the GraphQL `Micros` scalar.
6. **No personal data, by construction.** No email, no name, no IP, no free text, no prompt or completion
   anywhere in this list — not as an event property and not as a PostHog person property. The test that
   enforces it rejects a property whose *name* reads like personal data, so adding one means arguing with
   CI in the pull request that adds it.
7. **Server-side events are idempotent.** Each carries a `uuid` derived from the database row it reports,
   so a retried hook or a redelivered webhook cannot show up as two conversions.

### Shared properties

Properties that mean the same thing wherever they appear. An event references one; it never redefines it.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `campaign` | string | no | — | The invitation campaign the visitor arrived with — `InviteCode.campaign`, the free-text tag the generation CLI stamps on a batch of codes (SUP-142). This is the join key between the two tools and the database; omitted when the visit carried no code. |
| `has_invite` | boolean | yes | — | Whether the request carried an `?invite=` code (or the `cr_invite` cookie the landing set from one). Always present, so `false` is a countable population rather than a gap. |
| `utm_source` | string | no | — | `utm_source` as it arrived in the URL, lower-cased and trimmed. Landing only. |
| `utm_medium` | string | no | — | `utm_medium` as it arrived in the URL, lower-cased and trimmed. Landing only. |
| `utm_campaign` | string | no | — | `utm_campaign` as it arrived in the URL, lower-cased and trimmed. Usually equal to `campaign`, but it is the marketer's string, not ours, so the two are recorded separately. |
| `utm_content` | string | no | — | `utm_content` as it arrived in the URL, lower-cased and trimmed — which variant of the mail the click came from. |
| `position` | string | yes | `nav` `hero` `how_it_works` `verify` `models` `pricing` `faq` `closing` `footer` | Which part of the page the element sits in. A closed set: it is the breakdown the copy decisions are made from, so a new section adds a value here in the same change. |
| `outcome` | string | yes | `granted` `refused` | Whether the server-side action credited the account or declined to. |
| `grant_micros` | integer | no | — | Micro-USD credited, integer, per the money convention in ADR-005 ($100 is 100000000). Present only when `outcome` is `granted`. |

## Landing — Plausible

### `landing_view`

**Fires when** the landing page is loaded at router.superprotocol.com. This is Plausible's automatic pageview, not a second custom event.

**Owner** SUP-144 · **transport** `browser`

The name is the taxonomy's; in Plausible's UI the row reads `pageview`. The properties below ride it through the `pageview-props` script variant, so no extra request is made and the page is never double-counted.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `has_invite` *(shared)* | boolean | yes | — | [As above](#shared-properties). |
| `campaign` *(shared)* | string | no | — | [As above](#shared-properties). |
| `utm_source` *(shared)* | string | no | — | [As above](#shared-properties). |
| `utm_medium` *(shared)* | string | no | — | [As above](#shared-properties). |
| `utm_campaign` *(shared)* | string | no | — | [As above](#shared-properties). |
| `utm_content` *(shared)* | string | no | — | [As above](#shared-properties). |

### `cta_click`

**Fires when** a primary call-to-action is activated (click, or Enter/Space on the focused control) — before the navigation, with Plausible's own queueing so the beacon survives the unload.

**Owner** SUP-144 · **transport** `browser`

`target: signup` is the landing half of the funnel: it is the last thing we can observe before the browser leaves for the console, which is a different origin with no shared identifier. Register it as a Plausible goal.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `position` *(shared)* | string | yes | `nav` `hero` `how_it_works` `verify` `models` `pricing` `faq` `closing` `footer` | [As above](#shared-properties). |
| `has_invite` *(shared)* | boolean | yes | — | [As above](#shared-properties). |
| `campaign` *(shared)* | string | no | — | [As above](#shared-properties). |
| `utm_campaign` *(shared)* | string | no | — | [As above](#shared-properties). |
| `target` | string | yes | `signup` `docs` `models` `contact` | Where the call-to-action sends the visitor. |

### `diagram_variant_shown`

**Fires when** the how-it-works diagram first enters the viewport, once per page load, reporting the variant the CSS actually resolved to.

**Owner** SUP-144 · **transport** `browser`

The artboard ships two diagrams and the breakpoint decides; this is how we learn which one most visitors were shown before judging the section's engagement.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `variant` | string | yes | `horizontal` `vertical` | Which of the artboard's two diagrams is rendered at this width. |
| `viewport_bucket` | string | yes | `mobile` `tablet` `desktop` `wide` | Coarse width bucket at the moment the diagram appeared: mobile <768, tablet <1024, desktop <1440, wide otherwise. Buckets, not pixels — a pixel width is a high-cardinality property and a weak fingerprinting signal. |

### `code_copied`

**Fires when** a copy button on a code sample succeeds (the clipboard write resolved), or the sample is copied with the keyboard from inside its container.

**Owner** SUP-144 · **transport** `browser`

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `has_invite` *(shared)* | boolean | yes | — | [As above](#shared-properties). |
| `snippet` | string | yes | `base_url` `curl` `python` `node` `openai_sdk` `model_slug` | Which sample was copied. The closed set is the samples the page ships; adding a sample adds a value. |

### `faq_opened`

**Fires when** an FAQ item is expanded. Collapsing it again sends nothing.

**Owner** SUP-144 · **transport** `browser`

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `question_id` | string | yes | — | The FAQ item's stable slug — the id already used as the disclosure's anchor, not the question text, so re-wording a question does not start a new series. |

### `docs_link_click`

**Fires when** an outbound link to documentation or to another Super Protocol property is activated.

**Owner** SUP-144 · **transport** `browser`

Plausible's outbound-link extension would report these as `Outbound Link: Click` with the raw URL; we send our own named event instead so the breakdown is a handful of destinations rather than one row per URL.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `position` *(shared)* | string | yes | `nav` `hero` `how_it_works` `verify` `models` `pricing` `faq` `closing` `footer` | [As above](#shared-properties). |
| `destination` | string | yes | `docs` `api_reference` `github` `attestation` `status` `superprotocol` | Which property the link leads to. Closed set: an unrecognised host is not sent at all rather than widening the breakdown. |

## Console — PostHog, through router-api

### `signup_started`

**Fires when** the sign-up screen is presented on console.router.superprotocol.com, once per page load.

**Owner** SUP-145 · **transport** `first-party-ingest`

Anonymous and deliberately unstitched: it is captured with `$process_person_profile: false` and a per-request random `distinct_id`, because linking it to the account that appears later would need an identifier stored in the visitor's browser — the thing ADR-006 §4 rules out. Read it as a volume, and read the landing → account edge from `cta_click{target: signup}`, from `invite_redeemed`, and from `inviteCampaignStats`.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `has_invite` *(shared)* | boolean | yes | — | [As above](#shared-properties). |
| `campaign` *(shared)* | string | no | — | [As above](#shared-properties). |
| `utm_campaign` *(shared)* | string | no | — | [As above](#shared-properties). |
| `entry` | string | yes | `landing_cta` `invite_link` `login_switch` `direct` | How the visitor reached the screen, from the URL alone: `landing_cta` when the invite or UTM parameters are present, `invite_link` when an invitation URL was opened directly at the console, `login_switch` from the sign-in screen's link, `direct` otherwise. |

### `feedback_form_opened`

**Fires when** the feedback form is opened from the console — the click, not the form provider's own view event.

**Owner** SUP-149 · **transport** `first-party-ingest`

Identified: the console posts it to router-api on the session, so `distinct_id` is the account's UUID and the form provider needs no identifier of ours in its URL.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `source` | string | yes | `balance_banner` `credits_page` `email_link` | Where the invitation to give feedback was shown. |
| `grant_eligible` | boolean | yes | — | Whether this account could still earn the second grant at the moment it opened the form. |

## API — PostHog, server-side

### `signup_completed`

**Fires when** router-api's account-creation hook has committed — the same `user.create.after` boundary the invitation grant runs in (SUP-142) — so the event exists only for accounts that exist.

**Owner** SUP-145 · **transport** `server`

The first identified event: `distinct_id` is the account's UUID. No email, no name, no IP is sent as a person property (ADR-006 §4). Idempotency `uuid` is derived from the user id, so a retried hook cannot double-count a sign-up.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `has_invite` *(shared)* | boolean | yes | — | [As above](#shared-properties). |
| `campaign` *(shared)* | string | no | — | [As above](#shared-properties). |
| `method` | string | yes | `password` `magic_link` `github` `google` | Which of ADR-004's three paths created the account. |

### `invite_redeemed`

**Fires when** the redemption attempt inside sign-up resolves — for every attempt that carried a code, whether it credited the account or was declined. A sign-up with no code sends nothing.

**Owner** SUP-145 · **transport** `server`

Refusals are the point: a campaign whose codes were all spent before the mail went out looks identical to a campaign nobody opened unless the refusal reason is recorded. Idempotency `uuid` is the `InviteRedemption` row id. `reason` mirrors `InviteRedemptionOutcome` in router-api.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `campaign` *(shared)* | string | no | — | [As above](#shared-properties). |
| `outcome` *(shared)* | string | yes | `granted` `refused` | [As above](#shared-properties). |
| `grant_micros` *(shared)* | integer | no | — | [As above](#shared-properties). |
| `reason` | string | no | `not_found` `expired` `exhausted` `disabled` `already_redeemed` `error` | Why the code was declined. Present only when `outcome` is `refused`. |

### `api_key_created`

**Fires when** the `createApiKey` mutation has committed. The key's own value and label are never part of the event.

**Owner** SUP-145 · **transport** `server`

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `campaign` *(shared)* | string | no | — | [As above](#shared-properties). |
| `has_spend_limit` | boolean | yes | — | Whether the key was created with a per-key spend limit. |
| `keys_after` | integer | yes | — | How many live keys the workspace has after this one — the cheap way to separate the first key (an activation step) from the tenth (an integration habit). |

### `first_request_sent`

**Fires when** a workspace's first generation reaches a terminal state, exactly once per workspace, decided by the workspace's own first-request timestamp inside the recording transaction rather than by a count.

**Owner** SUP-145 · **transport** `server`

The event the whole campaign is judged on: an account that redeemed $100 and never sent a token did not convert. `inviteCampaignStats.activated` answers the same question from the database and is the number to trust when the two disagree.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `campaign` *(shared)* | string | no | — | [As above](#shared-properties). |
| `model_slug` | string | yes | — | The catalogue slug of the model the first request went to — a closed set in practice, since it can only be a model the router serves. |
| `hours_since_signup` | integer | yes | — | Whole hours between account creation and this request, floored. Hours rather than a timestamp difference computed in the tool, so the number survives export. |
| `had_invite_grant` | boolean | yes | — | Whether this workspace's ledger holds an invitation grant — the split that says whether the $100 did anything. |

### `model_requested`

**Fires when** the `requestModel` mutation has committed a row.

**Owner** SUP-146 · **transport** `server`

The requested model name and any note stay in our database, where SUP-146's admin aggregation and CSV export read them. They are not event properties: free text is a breakdown with one row per request, and it is the one field on either surface where a visitor could type something personal.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `source` | string | yes | `models_page` `empty_state` `dashboard` | Which screen the request was raised from. |
| `has_details` | boolean | yes | — | Whether the requester wrote anything in the free-text field — how much the field earns its place, without reading it. |

### `feedback_grant_applied`

**Fires when** the signed form webhook has been verified and the second grant resolved, whether it credited the account or was declined.

**Owner** SUP-149 · **transport** `server`

Idempotency `uuid` is the ledger entry id (or the webhook delivery id on a refusal), so a provider redelivery cannot show as two grants. No answer text is ever sent.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `outcome` *(shared)* | string | yes | `granted` `refused` | [As above](#shared-properties). |
| `grant_micros` *(shared)* | integer | no | — | [As above](#shared-properties). |
| `reason` | string | no | `already_granted` `not_eligible` `unknown_account` `error` | Why the second grant was declined. Present only when `outcome` is `refused`. |

## The funnel, and the one thing it cannot do

The launch is judged on five steps:

```
landing_view  →  cta_click{target: signup}  →  signup_completed  →  invite_redeemed{outcome: granted}  →  first_request_sent
└──────────────── Plausible ────────────────┘  └──────────────────────── PostHog ────────────────────────────────────────┘
```

It is two funnels joined on `campaign`, not one, and that is deliberate. The landing and the console are
different origins, and stitching a visitor across them needs an identifier stored in their browser —
exactly what [ADR-006 §4](../adr/ADR-006-analytics.md) rules out, and what would put a consent banner in
front of the campaign we are measuring. So:

- **Plausible** measures the landing and ends at the click that leaves it. `cta_click{target: signup}`
  is the last observable landing step.
- **PostHog** begins at `signup_completed`, which is identified (`distinct_id` = the account's UUID) and
  runs through to `first_request_sent`.
- **`signup_started` does not bridge them.** It is captured anonymously, with no person profile and a
  per-request `distinct_id`, so it counts sign-up screens presented and nothing else. Treat it as a
  volume, never as a funnel step.
- **`campaign` is the join.** It arrives in the invitation URL, it is stored on the redemption, and it is
  a property on both halves — so "campaign X produced N accounts, M of which sent a request" is
  answerable, and is answerable from the database too.

## Tool configuration

Settings the events assume. They are UI state, not repository state, so they are written down here.

**Plausible** — site `router.superprotocol.com`, EU-hosted, cookieless.

- Script variant: `script.pageview-props.tagged-events.js`. `pageview-props` is what carries the
  properties on `landing_view` without a second request; `tagged-events` is what lets the markup declare
  a custom event with a class rather than shipping a handler per button.
- Goals, created from the names in this document: `cta_click`, `code_copied`, `faq_opened`,
  `docs_link_click`, `diagram_variant_shown`.
- Outbound-link tracking stays **off**: `docs_link_click` reports a closed set of destinations, where the
  extension would report one row per URL.
- Optional, recommended to SUP-147: proxy `/js/script.js` and `/api/event` through the landing's ingress
  so the beacon is first-party. It is not a tracking measure — nothing changes about what is collected —
  it just stops a third of the numbers disappearing into blocklists.

**PostHog** — EU cloud, `https://eu.i.posthog.com`.

- Autocapture **off**, session recording **off**, heatmaps **off**, surveys **off**, web analytics
  **off**. A product whose pitch is that prompts are unreadable cannot ship a recorder pointed at its own
  console.
- Person profiles: **identified events only**. Anonymous events are captured with
  `$process_person_profile: false`.
- GeoIP-based IP discard **on**, and the server library sends `$ip: null` explicitly. With server-side
  capture the only address PostHog would otherwise see is our cluster's, which is worse than useless:
  it would geolocate every customer to Frankfurt.
- Event retention: **12 months**, set on the project. Nothing here is worth keeping longer, and a
  retention window we can state on `/privacy` is worth more than the data.
- Person properties are an allow-list of two: `campaign`, and `signup_method` (the person-level copy of
  `method`, set once at sign-up). No email, no name.

**Credentials** — the names are fixed (SUP-143 comment, 2026-09-25); code against exactly these.

| Name | Where | Kind | Read by |
| --- | --- | --- | --- |
| `POSTHOG_PROJECT_KEY` | `confidential-router` Actions variable, then the deployment's environment | variable — a write-only ingest key, not a secret | `router-api` |
| `POSTHOG_HOST` | same | variable, `https://eu.i.posthog.com` | `router-api` |
| `TYPEFORM_ACCESS_TOKEN` | `confidential-router` Actions secret | secret | CI only (SUP-149's `workflow_dispatch` job) |
| `TYPEFORM_WEBHOOK_SECRET` | generated and stored by SUP-149 | secret | `router-api` |

The landing repository holds no analytics secret: Plausible's snippet is public and the site is
configured in Plausible's UI.

Note that `POSTHOG_PROJECT_KEY` is read by `router-api`, not by the browser — with the console reaching
PostHog only through our own server (ADR-006 §3), it never needs to travel in the console's runtime
public config (SUP-100). It stays a deployment value rather than an image build argument either way.

## Verification (SUP-148)

The launch rehearsal proves the funnel with one scripted pass, on staging, with a campaign of its own
(`rehearsal-<date>`) so the numbers never mix with a real mailing:

1. Open `https://router.superprotocol.com/?invite=<REHEARSAL_CODE>&utm_source=rehearsal&utm_medium=email&utm_campaign=rehearsal-<date>`.
   → Plausible shows a `landing_view` with `has_invite: true` and the four UTM properties.
2. Expand an FAQ item, copy the `curl` sample, click the hero call to action.
   → `faq_opened`, `code_copied{snippet: curl}`, `cta_click{position: hero, target: signup}`.
3. Complete sign-up on the console.
   → PostHog shows `signup_started`, then `signup_completed{has_invite: true, campaign: rehearsal-<date>}`
   and `invite_redeemed{outcome: granted, grant_micros: 100000000}` against the new account's UUID.
4. Create a key and send one request.
   → `api_key_created{keys_after: 1}`, then `first_request_sent{had_invite_grant: true}`.
5. Cross-check against the database: `inviteCampaignStats(campaign: "rehearsal-<date>")` reports
   `issued: 1, redeemed: 1, activated: 1`.

A step that does not appear is a bug in the emitter, not in the tool — every one of these is asserted by
the e2e tests of the issue that owns it.

## Changing the taxonomy

Edit `schemas/analytics-taxonomy.json` and this document in the same commit; the test compares them.
Renaming a shipped event splits its history in both tools, so prefer adding a property to renaming an
event, and if a rename is right, do it before the mailing goes out rather than after.
