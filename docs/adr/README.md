# Architecture Decision Records

ADRs capture decisions that every implementation task codes against. They are short, dated, and
immutable once `Accepted`; superseding decisions get a new number and link back.

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-001](./ADR-001-repo-and-language-split.md) | Repository & language split (Nx multi-language, Go gatekeeper, TS router) | Accepted |
| [ADR-002](./ADR-002-attestation-topology.md) | Attestation topology — only the gatekeeper → router channel is attested | Accepted |
| [ADR-003](./ADR-003-gatekeeper-trust-model.md) | Gatekeeper trust model — trusted roots, per-endpoint pinned `evidenceDigest`, Rego AND-semantics, fail-closed | Accepted |
| [ADR-004](./ADR-004-console-auth.md) | Console authentication — OAuth (GitHub/Google) + email magic link, sessions in PostgreSQL | Accepted |
| [ADR-005](./ADR-005-billing.md) | Billing — prepaid credits ledger + Stripe, no crypto | Accepted |

Companion documents:

- [Threat model](../threat-model.md) — what the router can and cannot see, why verdicts never reach it.
- [Router API contract](../contracts/router-api.md) — OpenAI-compatible REST subset, errors, auth, usage.
- [Console GraphQL outline](../contracts/console-graphql.md) — target SDL for the code-first NestJS schema.
- [Data model](../contracts/data-model.md) — TypeORM entities of `router-api`.
- [Gatekeeper Rego contract](../contracts/rego-input.md) — `input` document, generated trust module, default policy.
- Machine-readable contracts in [`/schemas`](../../schemas/README.md), validated by `libs/types` in CI.

Conventions: status ∈ {Proposed, Accepted, Superseded}; "Decided by" names the human decision on record
(Denis, 2026-08-30, parent planning issue) — ADRs restate those decisions with rationale and consequences,
they do not reopen them.
