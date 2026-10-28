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
| `has_invite` | boolean | yes | — | Whether the request carried an `?invite=` code. On the landing that means the URL and nothing else; on the console it also covers the `cr_invite` cookie the console sets on its own origin before an OAuth redirect, so the code survives the round trip. Always present, so `false` is a countable population rather than a gap. |
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
| `snippet` | string | yes | `openai_sdk` `curl` `python` `node` `gatekeeper_sdk` `install` `gatekeeper_setup` `gatekeeper_test_build` `gatekeeper_verdict` | Which sample was copied. The closed set is the samples the page ships; adding a sample adds a value. Named from the landing page as built (SUP-144): the hero's OpenAI SDK example, the four code tabs (`curl`, Python, Node, and the same call through a local Gatekeeper), the Gatekeeper install one-liner, its setup commands, and its verdict output. SUP-253 added `gatekeeper_test_build`, the collapsed block for a cloud the Super Protocol registry has not signed. The original list was written before the page existed and named two blocks — the base URL and a model slug — that carry no copy button. |

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
| `method` | string | yes | `password` `email_code` `magic_link` `github` `google` | Which sign-in path created the account. `email_code` (SUP-269) is the emailed one-time code; `password` is no longer a sign-up path and remains for accounts already reported under it and for the bootstrap account. |

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
| `client` | string | yes | `vscode-chat` `cline` `roo` `continue` `cursor` `claude-code` `openai-python` `openai-node` `litellm` `langchain` `curl` `other` | Which client sent the activating request. [The closed set below](#the-client-dimension); anything unrecognised is `other`. |

### The `client` dimension

A closed set of twelve values, derived in the `/v1` gateway and stored on `generations.client` as well as
carried on `first_request_sent` (SUP-466). It exists because SUP-447 spent two days establishing which
editor a tester was using from screenshots, while the answer was in a header on every request he sent —
and because behaviour differs sharply between these clients, some of them failing in ways the user never
reports.

**The raw `User-Agent` is never stored and never sent.** It is a fingerprinting vector, and this
repository already treats it as one: `invite_redemptions.userAgentHash` keeps a salted hash for abuse
review and the address itself never lands. What the column and the event hold is a label with no version
in it — `cline`, not `cline/3.2.1` — no operating system, no architecture, no editor build and no locale.
There is no `other_raw` escape hatch, deliberately: that would be the agent string with extra steps.

| Value | Matched on | A real string that produces it |
| --- | --- | --- |
| `vscode-chat` | `copilotchat` | `GitHubCopilotChat/0.69.0` |
| `cline` | `cline` | `Cline/SDK` |
| `roo` | `roocode` | `RooCode/3.54.0` |
| `continue` | `continue/` | `Continue/IDE` |
| `cursor` | `cursor/` | `Cursor/1.0` |
| `claude-code` | `claudecli/`, `claudecode/` | `claude-cli/2.1.291 (external, sdk-cli)` |
| `openai-python` | `openai/python` | `OpenAI/Python 3.35.1` |
| `openai-node` | `openai/js` | `OpenAI/JS 5.23.2` |
| `litellm` | `litellm` | `litellm/1.106.2` |
| `langchain` | `langchain` | `langchainjs-openai/1.0.0 ((node/v22.23.2; linux; x64))` |
| `curl` | `curl/` | `curl/8.5.0` |
| `other` | nothing above | `node`, `axios/1.20.0`, no `User-Agent` at all |

Three rules make the table readable, and `client-dimension.spec.ts` holds every string above with the
capture it came from:

1. **Unrecognised is `other`, and so is absent.** A request with no `User-Agent` is classified, not
   skipped — `other` is a countable population, where null would mean "nobody looked". The column is
   nullable only for the rows written before the dimension existed.
2. **Extend by pull request, never by passthrough.** A large `other` bucket is the signal to add a row;
   its size alone is the evidence, so nothing needs to be kept to find out.
3. **Needles are matched normalised** — lower case, `-`, `_` and spaces removed — and the first match
   wins. `roo` is tried before `cline` because Roo Code is a Cline fork that still carries `Roo-Cline` in
   its strings; `langchain` and `litellm` before the OpenAI SDKs, because they wrap them. The needles are
   as narrow as the captured strings allow: `copilotchat`, not `copilot`, so a future Copilot that is not
   VS Code's chat lands in `other` rather than under a label that is wrong about it.

Which headers are read, and how much of each, is part of the rule:

- **`User-Agent` and `X-OnBehalf-Extension-Id`** are written by the client's own HTTP stack — a product
  string rather than free text — so a needle matches anywhere inside them. The second is VS Code's, not
  the caller's: it carries `github.copilot-chat/<version>` and survives an agent string the editor's
  fetch chose rather than the editor itself.
- **`X-Title`** is the OpenRouter-convention app name, and the **caller picks its value**. It is matched
  only when the whole value *is* a label — `X-Title: Cline`, `X-Title: Roo Code` — never as a substring,
  because a substring rule would read `X-Title: Declined requests` as `cline` and `X-Title: My Copilot
  Dashboard` as `vscode-chat`. A wrong label is worse than an honest `other`, by the same argument that
  keeps the agent string out of the column. Taking the value at face value when it names a client exactly
  is not a risk of the same kind — that is the caller telling us what it is, and it is the only signal
  Cline gives on the path where it sets the header at all.
- **`HTTP-Referer`** is read by nothing, though these clients send it: Roo Code's value is
  `https://github.com/RooVetGit/Roo-Cline`, which names the editor it was forked from rather than itself.

Three of the twelve are reachable only from some configurations, which is a fact about the clients rather
than about the mapping, and the `other` bucket is where the difference goes:

- **Cline 4.1.25** sends `user-agent: node` or an `ai-sdk/openai-compatible/…` string against an
  OpenAI-compatible endpoint, naming neither itself nor its editor. It identifies itself only on its own
  routing provider, which is where `Cline/SDK` and `X-Title: Cline` come from.
- **Continue 2.0.0** sends `OpenAI/JS 5.23.2` — it is the OpenAI Node SDK, and is counted as
  `openai-node`. `Continue/IDE` is sent only to one specific provider.
- **LiteLLM** and **LangChain Python** both announce themselves as `OpenAI/Python` on the path most
  people use; LiteLLM sends `litellm/<version>` only from its own HTTP handler, and only LangChain **JS**
  carries a `langchain` token.

Nothing in this derivation reads the request body. Those clients *are* distinguishable by their system
prompts, and that is exactly why we do not look: a label concluded from prompt text is a conclusion
drawn from content, which is the one thing the metering path does not do.

### `model_requested`

**Fires when** a `/v1` request names a model and the router has decided whether it will serve it — once per request, before anything is forwarded, on the success path and on every refusal alike. A request that names no model at all sends nothing: there is no demand to record.

**Owner** SUP-542 · **transport** `server`

Re-pointed by SUP-542 from the never-shipped `requestModel` console form (SUP-146) to the `/v1` path, which is where the question is actually answered: which model people ask for, how often, and whether anyone asks for one we do not serve. Nothing here is read from the request body beyond the `model` field — no prompt, no completion, no system text. Idempotency `uuid` is derived from the generation id the router mints for the request, so the per-request event stays exactly once per request.

| Property | Type | Required | Values | Meaning |
| --- | --- | --- | --- | --- |
| `model_slug` | string | yes | — | The model the request asked for, as it asked — lower-cased, trimmed, capped at 64 characters, and only when it has a model identifier's shape (`[a-z0-9]`, then any of `. _ : / + -`). Anything else is reported as `unparseable` rather than passed through. |
| `result` | string | yes | `served` `unknown_model` `out_of_key_scope` `not_verified` `unsupported_route` | What the router decided. `unknown_model` is the roadmap signal — somebody asked for a model we do not have. `not_verified` is fail-closed working rather than demand. |
| `route` | string | yes | `chat` `completions` `embeddings` | Which OpenAI-compatible route the request came in on. |

**On `model_slug` and convention 2.** It is the one property in this list whose value a caller supplies, so it is bounded rather than trusted: the shape check above, a 64-character cap, and a single `unparseable` row for everything else. In practice a client's own configuration writes this field, so the breakdown is the handful of ids the OpenAI ecosystem uses — and that is precisely the breakdown the question needs. A caller who puts prose there buys one row called `unparseable`, not a row of their own.

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

Which means a deployment can be rebuilt without it, so **whether it arrived is checkable**:
`GET /health` reports `analytics: { status: "configured" | "disabled", dropped: <count> }` — the sink the
process actually built, plus a monotonic count of events lost since boot (SUP-464). A deployment that
should be capturing and reads `disabled` is missing the variable; `dropped` climbing while `configured` is
PostHog refusing or unreachable. Neither ever makes `/health` fail — see `docs/contracts/router-api.md`,
`GET /health`.

The chart does not publish `/health`, so on a deployment this is read through `GET /admin/health` — the
same document behind the operator's session (SUP-479).

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
