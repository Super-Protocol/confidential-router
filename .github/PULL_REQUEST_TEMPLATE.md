## Summary

<!-- What changed and why. Link the issue. Call out anything a reviewer would
     otherwise have to reverse-engineer from the diff. -->

## Test plan

<!-- List every test you added or changed, and how you ran them. If you added
     none, say so explicitly and explain why. "CI is green" is not a test plan. -->

- [ ] `pnpm nx affected -t lint typecheck build test`
- [ ] Tests added/updated:

---

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) — it becomes the squash commit subject
- [ ] No hand-edits to generated code
- [ ] No new `@swarm-cloud/*` dependency; ported code is recorded in `NOTICE`
- [ ] Docs updated if behaviour or setup changed
