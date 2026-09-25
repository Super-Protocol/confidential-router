## Summary

SUP-144, a two-file change to the taxonomy's one enumeration that did not survive contact with the page it describes.

`code_copied.snippet` was enumerated in SUP-143, before the landing page existed. Two of its six values name blocks that carry no copy button (`base_url`, `model_slug`), and four blocks that *do* had no name at all: the Gatekeeper install one-liner, its three setup commands, its verdict output, and the "through your Gatekeeper" variant of the SDK example.

The taxonomy already says what to do about that — "the closed set is the samples the page ships; adding a sample adds a value" — so this is that change, made from the page as built:

`openai_sdk` `curl` `python` `node` `gatekeeper_sdk` `install` `gatekeeper_setup` `gatekeeper_verdict`

The landing implementation (Super-Protocol/confidential-router-landing#5) codes against this list, and holds its own copy of it to a unit test. Nothing on the console side reads `snippet`.

## Test plan

No new test: `libs/types/src/analytics/analytics.spec.ts` already holds the JSON, its typed view and the document to each other, including that every enum contains its own example and that every property appears in `docs/contracts/analytics-events.md`. `pnpm nx test types --skip-nx-cache` passes (93).

---

- [x] PR title follows Conventional Commits
- [x] No hand-edits to generated code
- [x] Docs updated — `docs/contracts/analytics-events.md` changed in the same commit as the schema
