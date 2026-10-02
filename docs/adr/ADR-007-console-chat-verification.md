# ADR-007 — Console chat and its three verification tiers

- **Status:** Accepted
- **Date:** 2026-09-30
- **Decided by:** Denis (SUP-180)

## Context

Everything the product has shipped so far assumes the user installs Gatekeeper. That is the right
answer for production traffic and the wrong answer for a demo: the people we mail an invitation to
want to type a question into a box and see a confidential model answer it, and most of them will
not install a proxy to do that.

So the console gets a chat screen. The moment it exists, two things that were previously simple
stop being simple.

1. **Verification.** ADR-002's one architectural rule is that the *router* never asserts a verdict.
   A page, however, is not the router — it is code running in the user's browser, and it can verify.
   But that page was served *by the deployment it would be verifying*, which makes its verdict
   worth strictly less than the extension's and much less than Gatekeeper's. Presenting all three
   as "verified" would be the most misleading thing the product could say.
2. **The conversation.** A chat has a history. Storing it server-side is a durability and a privacy
   claim at once, and the API surface has never held a byte of prompt text
   (`docs/contracts/data-model.md`, the `Generation` invariant).

## Decision

### 1. The chat is not a special inference path

Messages go to `POST /v1/chat/completions` with a real workspace API key, from the browser, over the
same gateway every other client uses — same guard, same rate limits, same metering, same billing.
There is no console-only inference route and no `sendMessage` mutation. A second path would be a
second thing to audit, and the whole claim of the screen is that it is not privileged.

The key is minted by `chatCredential`, marked `api_keys.purpose = 'console_chat'`, scoped to the
chat-capable catalogue, and short-lived (`chat.credentialTtl`, default 2 h). It is held in the tab's
memory only. Asking for one rotates it: **this user's own** previous chat key in that workspace is
revoked, because its plaintext was shown once and is unrecoverable, so there is nothing to reuse.

Rotation is scoped to `(workspace, user)` and not to the workspace, which is the narrower query on
purpose. A workspace has members; revoking every chat key in it meant one person opening the chat
silently breaking the tab another person had open, for as long as their cached secret would otherwise
have lasted — and a reload only reversed who was broken. Two members chatting at once is the ordinary
case for a demo surface. The browser closes the remaining gap: on `api_key_revoked`,
`api_key_expired` or `invalid_api_key` the screen drops its cached secret and mints **once** more, so
a key that dies under a tab for any other reason — an operator revoking it from the Keys screen, the
same user rotating from a second tab — costs one retry rather than a reload. Refusals a fresh key
would not fix, such as `insufficient_credits`, are not retried.

### 2. Three tiers, three different claims, never blurred

| Tier | Who checks | What it proves | Badge |
| --- | --- | --- | --- |
| 1 | This page, with `@confidential-router/attestation` | The deployment published a fresh, correctly signed bundle whose chain is internally valid and whose signed TLS fingerprint matches the certificate it publishes | "Verified by this page" + "this is self-reported" |
| 2 | The Super Protocol browser extension | The same, checked by code the browser pinned from the web store and that the deployment did not serve | "Independently verified by the extension" |
| 3 | Gatekeeper, on the user's machine | All of the above against the **live** TLS certificate, plus the VM launch measurement rebuilt from Super Protocol's signed `sp-vm` artefacts | "Verify it yourself" |

Tier 1 **gates the composer**: nothing is sent until it passes. Tier 2 is feature-detected over a
tiny versioned `postMessage` protocol and can only *upgrade* the badge or refuse — an absent
extension is never an error and never blocks anything. A tier-2 refusal outranks a tier-1 pass,
because the extension is the less credulous of the two.

Tier 2's answer is accepted on the identity of the channel — `event.source` must be the very window
the request was posted into — and not on the shape of the payload. Every field in a verdict is a
string an attacker can copy, and tier 2 is the only path that reaches the word "independently", so
where the answer came from is the one part that must not be forgeable. `event.origin` is deliberately
not also checked: a same-window post carries this document's own origin, so it adds nothing, and it is
`"null"` inside a sandboxed frame, which would reject a legitimate answer for no gain.

This does not reopen ADR-002. Each tier is the *viewer's own agent* reporting what it did; the
router never learns the answer, stores it, or displays one of its own.

### 3. Tier 1 asks the sp-vm registry, not a trust store

`verifyHostname` in `@confidential-router/attestation` answers "does this chain terminate at a root
in my trust store". A page served by the deployment under test has no independent trust store, and
pinning the root out of the bundle being checked would be a green tick that proves nothing. So the
chat calls the verifier's stages individually and asks the root question of something outside the
deployment: the signed `sp-vm` measurement registry, under an RSA key pinned in the console bundle —
byte-identical to the one `apps/gatekeeper/pkg/attestation/attestedroot/registry.go` pins, so the
page and the gatekeeper accept the same set of images.

Consequence, stated plainly because it is the honest part: the root check reports **"not
established"** on the live platform — neither a pass nor a failure — and the gate does not hold the
composer for it. What *does* hold it is the next subsection; the two are easy to conflate and were.

*Why* it is not established took a correction (SUP-185). The first version read
`rootCaTeeQuote: {"status": "not-implemented"}`, found nothing, and told the reader that the platform
publishes no TEE quote for the hostname. That was false. The platform does publish one: a full
SEV-SNP report, in the root certificate's TEE-evidence extension
(`0.6.9.42.840.113741.1337.6`) — inside the very bundle the page had already parsed.

So the page now reads it. `readRootAttestation` in `@confidential-router/attestation` decodes the
three extensions a Super Swarm root carries, and the root row reports what is in them: the evidence
type, the sp-vm release, and whether the report's `REPORT_DATA` commits to the root's own public key
— which is a real cryptographic check, and the one thing on this row a browser can settle. A report
that attests some *other* key makes the row **fail**: that is a negative result, not an absence.

That refusal outranks the registry, and it is settled before the registry is asked at all. The first
cut of this fix got it wrong in a way worth recording: the check lived inside the no-measurement
branch, so a bundle that *also* published an `mrenclave` the registry vouches for skipped it and the
row went green. Both of those are producer-controlled strings, and neither binds a registry entry to
this root's key — a vouched measurement proves some VM is one of Super Protocol's, not that this
root's key is that VM's. Adding them up to a pass is precisely the failure the tier rule exists to
prevent, so `liftedEvidenceRefusal` runs first on every path and the lookup is skipped: no verdict it
could return would change the row.

What stays out of reach is the last step, and it is worth being exact about why, because the
plausible shortcut is a trap. The signed sp-vm registry is not indexed by the report's own
`MEASUREMENT`. It is indexed by `SHA-256(normalised-launch-digest ‖ vmpl ‖ policy)`, where the
digest is rebuilt page by page from the release's OVMF image and kernel artefacts for a canonical
single-Milan-core VM — `snpmeasure.Normalize` in the gatekeeper. The report's measurement is hex of
a length `isMeasurementHex` accepts, so feeding it to the registry would *work*, return
`not-in-registry`, and have the page tell a reader that a sound deployment is not one Super Protocol
vouches for. A wrong red is worse than an honest question mark, so the page does not do it and says
what it cannot do instead.

The row therefore also warns that Gatekeeper, which does rebuild the digest, may reach a different
verdict — including refusing the endpoint the composer was just unlocked for. That is not
hypothetical: on the demo cloud today the root measurement is absent from `Super-Protocol/sp-vm`, so
the four commands tier 3 hands over end in `exit 3`. The tier-3 panel carries the same warning above
the quick-start, and tier 1's badge caveat says a stronger check can refuse rather than only that it
is stronger. A screen that let a reader discover the contradiction from a shell is a screen that
knew and did not say.

Evidence is fetched from the endpoint directly where CORS allows it and from this router's public
`GET /v1/evidence/:endpoint` passthrough where it does not. The signature is checked either way, so
a relayed bundle cannot be forged — but it can be staler than what the host serves now, and the
panel says which source answered.

### 3a. A row that answered "no" holds the composer; a row nobody could answer does not

The unlock rule is two clauses, not one list: every check in `BLOCKING` must come back `pass`, **and
no check may come back `fail`**. `root` is not in `BLOCKING` — that is deliberate and is what keeps
the live platform usable — but a `fail` from it shuts the composer like any other.

The distinction is the whole rule, and both halves matter:

- **`unavailable` must not block.** On the live endpoint the quote is present, its key binding holds,
  and only the registry rebuild is out of a browser's reach. Locking there would shut the demo
  surface for a platform limitation the screen has already disclosed in words — and it would stay
  shut until sp-vm measurements became browser-derivable, which is to say for good.
- **`fail` must block.** A non-binding quote is the one negative this page establishes on its own,
  with its own cryptography, and the row's copy tells the reader not to trust the endpoint over it.
  A screen that prints that sentence behind a badge reading "Verified by this page", over an open
  composer, is not disclosing a limit — it is contradicting itself.

The second half was missing until QA traced it (SUP-185) on a bundle they minted for the purpose: the
production TEE evidence, byte for byte, over a different key. Chain, signature, freshness and binding
all pass; only the root row catches it; and the badge said "Verified by this page" anyway, because
`BLOCKING` decided the composer without consulting the root row at all.

It is stated as a principle rather than as `root`-when-failed because that is what it is: a check that
came back negative blocks, a check nobody could answer does not. For the rows in `BLOCKING` it changes
nothing — they return early on failure — so `root` is the only row it reaches today, and a later
informational row that can genuinely fail gets the safe default rather than a silent pass.

One consequence worth naming in advance: `not-in-registry` is a `fail`, so if the platform starts
publishing measurements and one is not in the registry, that endpoint's composer will lock. That is
the intended outcome — it is exactly the endpoint Gatekeeper refuses, and the alternative is the
badge's strongest sentence over a VM the registry has just declined to vouch for. It is unreachable
today, since no producer publishes a measurement.

### 4. History is stored inside the boundary, and is explicitly not durable

Threads live in `chat_threads` / `chat_messages` on the deployment's own state,
which sits inside the attested boundary and is encrypted at rest by the in-TEE
LUKS disk: the host sees ciphertext and the key never persists. A transcript is
scoped to `(workspace, member)` — a workspace has members, and one member's demo
conversation is not another's to read — and deletion is a delete, with
`chat_messages` cascading from its thread.

These two tables are **the one documented exception** to "no request content
reaches this database". The metering invariant is untouched and still absolute
for `generations`: a chat message travels to the model over the ordinary
`/v1/chat/completions` path, which records tokens, cost and model and no content.
What is stored here is the transcript the user asked us to keep. The exception is
bounded by two tests rather than by reviewer memory — `invariants.spec.ts`
asserts that `chat_messages.content` is the *only* content column in the schema,
and `app/chat/chat-content-boundary.spec.ts` asserts the four edges the content
must not cross: logs, analytics events, the evidence snapshot, and the export.

**What this deliberately does not claim is durability.** Denis deferred the
durability work and accepted the risk (2026-09-30, after SUP-179): the in-TEE
state disk is ephemeral by design, so infrastructure maintenance can take a
transcript with it. "Stored inside the attested boundary" is a *confidentiality*
claim, and a reader will hear it as a durability claim unless something beside it
says otherwise — so every surface that mentions storage carries the maintenance
risk too. `tiers.spec.ts` pins that wording in both directions: the words that
must appear, and the words that must not (`backup`, `restore`, `recover`,
`guarantee`).

**Amended by SUP-189: the caveat is published one click away, not inline.** The
first cut put it in the summary, which left "may be lost during maintenance"
permanently under the composer — a warning banner on the surface a prospect is
shown first, and the reaction it drew. The requirement did not change, its
placement did: the inline line is now the affirmative half alone (`Stored inside
the attested boundary`), and an ⓘ beside it opens a popover carrying the
encryption, the deletion — with a link that focuses the delete control for the
open conversation — and the durability caveat, quoted as the single sentence
/privacy §5a publishes. `storage-note.spec.tsx` asserts the split in both
directions, because the defect was never a wrong sentence; it was a true sentence
in the wrong place, and only a placement test catches that. The caveat carries a
`TODO(SUP-183)`: the release train that ships replicated PostgreSQL deletes it
from the popover and from /privacy together.

The console still reads `chatSettings.historyStorage` rather than assuming, and
derives its copy from the answer. `BROWSER_LOCAL` remains in the enum because it
is the honest answer for a deployment with no such storage.

### 5. Sanity limits, not business rules

`chat.maxMessageChars`, `chat.maxThreads`, `chat.maxMessagesPerThread` are config, published to the
browser, and enforced where the history lives. They exist so a demo surface cannot become a free
storage service. `chat.enabled: false` removes the screen and refuses `chatCredential`.

`maxMessageChars` is one number and two behaviours, which is deliberate (SUP-187). A **question** over
it is refused, and that refusal is worth having precisely because it happens *before* the browser calls
a model — nothing has been metered yet. An **answer** over it has already been streamed to the reader
and billed, so it is kept, cut to the same ceiling, and the cut is recorded in the turn's `error`, which
is what the screen shows and what the console filters out of the next prompt. One ceiling rather than a
larger second one for answers, because the number is a factor in the per-member storage bound.

### 6. The chat needs a secure origin, and says so when it does not have one

Browsers expose `crypto.subtle` only in a secure context — HTTPS, or
`http://localhost`. The verifier is Web Crypto from end to end, so a console
served over plain HTTP on a *named* host cannot verify anything, and the chat
stays locked. That is the correct outcome; the part worth deciding was what it
*says*. Every signature stage failing with "SubtleCrypto is not available" made
the panel report "the certificate chain is not valid", which accuses the
deployment of something that is true of the page. So the gate answers Web Crypto
first, before it fetches anything, and the message names the fix.

A production deployment serves the console over HTTPS and is unaffected. Two
places are not: a developer on a named http origin, and the console e2e suite,
which serves `http://console.localtest.me:4300` on purpose so that cookie
behaviour matches production (`apps/router-ui-e2e/src/origins.ts`). The suite
therefore tests this refusal rather than the happy path, and the happy path is
covered by the component tests, which run the verifier against the
cross-implementation conformance vectors where Web Crypto exists.

### 7. "Inspect attestation": the measurements, and a graph of the signed document

The badge answers *has this been verified, and by whom*. There is a second
question — *what does the document actually say* — and it needs a screen of its
own: the measurements in full, and the deployment the evidence describes, drawn
out (SUP-190). Four decisions hold it together.

**It consumes tier 1's result and verifies nothing.** The panel is a function of
the `useVerification` state the chat screen already holds; "Check again" calls
that hook's own `recheck`. A second fetch-and-parse path would be a second thing
to keep in step with the gate, and the first time they diverged the screen would
be showing one answer beside a badge that reached another. To make the reuse
possible, `runEvidenceGate` now carries three things it previously discarded:
the verified payload's `evidence` snapshot, a summary of every certificate in
the chain, and the root report's policy and TCB fields.

**The graph is drawn from the signed snapshot, not from a live API.** That is the
point of it rather than an implementation note: the picture *is* the attested
document, so a reader who trusts the signature has to accept the picture — and
the panel says so in those words. `runEvidenceGate` returns no evidence at all
once a check fails, so a failure cannot reach the graph; the panel also states
the failure in the words of the failing check rather than rendering an empty
canvas, because a graph of a document whose signature did not verify would read
as "this deployment runs nothing", which is a more convincing wrong answer than
a stated failure.

**A container's digest is compared against something outside the evidence.**
`endpoints[].declaredImages` is an operator-declared allow-list, `{ name, digest }`
per image — the same shape a marketplace AppDefinition pins a component's images
with (`swarm-marketplace-spec` §2.7), so when listings land the source can move
without the shape changing. Comparing the snapshot against digests derived from
the same snapshot would be a green tick that proves nothing, which is why the
other side of the comparison is config. Five verdicts, and only one of them is
green: *declared*; *undeclared build* (the operator declares this image at
another digest — the loudest, because the declaration proves they know the
component); *undeclared*; *not digest-pinned* (a tag cannot be matched against a
pin even in principle); and *nothing declared*, which is where most deployments
are today. An absent allow-list and an empty one are different statements and
are stored and rendered differently: null is "nothing was declared", `[]` is
"this endpoint is declared to run nothing".

**It is a separate chunk, and a test says so.** react-flow is ~65 KB gzipped and
the chat is a screen most people open to type a message, so the panel is reached
only through a dynamic `import()` in `inspect-button.tsx`.
`attestation/code-split.spec.ts` walks the chat screen's static import graph and
fails if anything under `components/chat/attestation` except that button —
or `@xyflow/react` itself — becomes statically reachable. The entry button costs
about 1.5 KB gzipped on the `/chat` cold load; the panel costs nothing until it
is opened.

The panel's own accessibility is audited at `/dev/attestation`, a review route in
the same spirit as `/dev/components`: the populated panel cannot exist on the e2e
suite's origin (§6), so the route hands the real component a verified result
without a verifier, and the suite runs axe over it in both themes and walks the
graph with Tab. Each node is a `<button>` whose accessible name carries the
digest and the verdict in words — a colour is not a statement.

### 7a. One suite on a secure origin, because §6 left tier 1 unproven in a browser

§6 is right about the trade and has an unstated cost: if the only browser suite
runs on an origin the browser withholds Web Crypto from, then *nothing that
happens after the gate gives up* is ever exercised in a browser. The console
chat shipped with its happy path covered only by component tests — and the first
time it was pointed at the demo stack it failed at `binding`, because
`tools/mock-evidence-host` published no `tlsLeaf`. The field is in the bundle
contract and the live platform publishes it; the Go gatekeeper ignores it
because it observes the channel itself, so its absence had never cost anything
and nothing noticed. A browser has no channel to observe, so for a browser it is
the whole check.

So the mock host publishes the leaf it is serving, and
`playwright.secure.config.ts` runs one suite with the console and the API both on
`127.0.0.1`, which browsers treat as trustworthy. Tier 1 runs there for real:
bundle fetched, chain validated, JWS verified, graph drawn out of the payload
that verified, and a `/__mock/rotate-deployment` in the middle to prove the
undeclared-image path against an actually re-signed snapshot rather than a
doctored fixture.

It gives up the cookie isolation §6 bought, and that is the right price *for this
one suite only*: `secure-origin.spec.ts` installs the handoff cookie directly and
asserts nothing about cookies, while the suite that does care about them is
unchanged on its named origins. The two configs now state each other's cost in
their own headers, so neither reads as an accident.

`tools/demo` declares the two images its own evidence host publishes, so the
green verdict path is what the stand shows by default — and `rotateDeployment()`,
already a beat in the demo story, now turns the panel red, which is the clearest
thing the feature has to say.

## Consequences

- One new nullable column (`api_keys.purpose`), and two new tables —
  `chat_threads` and `chat_messages` — which are the documented exception above.
- The console bundle now imports `@confidential-router/attestation`, which is inside its 200 KB
  gzipped budget (`libs/attestation/src/__tests__/bundle-size.spec.ts`).
- The extension half of tier 2 is a swarm-cloud change (`apps/swarm-chrome-extension`). Until it
  ships, tier 2 reports "no extension detected" everywhere, which is a correct statement.
- A workspace that never opens the chat never has a `console_chat` key.
- The chat is unusable on a non-secure origin by construction (§6). An operator
  deploying the console over plain HTTP on a named host gets a locked chat and a
  message saying why; the API is unaffected.
- One more nullable column (`endpoints.declaredImages`), projected from the
  router config at boot like every other column on that table.
- `@xyflow/react` (MIT) is a new console dependency, loaded only by the
  attestation panel's chunk.
- A third Playwright config and an `e2e-secure` target, run unconditionally in
  CI — unconditionally because `nx affected` would skip it on exactly the
  changes most likely to break it, the gate being a library.
- `tools/mock-evidence-host` now publishes `tlsLeaf`. Producers already did; the
  gatekeeper still ignores it.
- The console's `EndpointEvidenceFields` fragment now asks for `declaredImages`,
  so Overview and Models carry it too. Neither renders it yet; the inspector is
  the only consumer.
- A transcript can be lost to infrastructure maintenance, by accepted decision.
  If durability is ever wanted, it is a platform change (a replicated storage
  class for cluster spaces, or a confidential backup target) and not a console
  one — and `maintenanceCaveat` in `tiers.ts` plus the landing's `consoleChat`
  constant are the two places that would then change together. The
  `TODO(SUP-183)` beside `maintenanceCaveat` is what names both of them, and it
  is the only marker this repository can hold: the landing is a separate
  repository, and an ADR claiming a marker over there would be asserting
  insurance it cannot see.
