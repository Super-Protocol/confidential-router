# contract-conformance

Fails when `apps/router-api/schema.graphql` does not satisfy the SDL in
`docs/contracts/console-graphql.md` (SUP-237).

```sh
node tools/contract-conformance/src/main.ts
```

**Which SDL.** Every ```` ```graphql ```` block under an `## As shipped …` heading. The document's
opening block is the SUP-66 design target, which the document itself says differs from the shipped
schema; it is not checked.

**What "satisfies" means.** Every type, field, argument, input field, enum value, union member and
implemented interface the contract names must exist in the schema with the same signature —
nullability and list wrapping included, and a default value when the contract states one. The schema
may carry more, except a *required* argument or input field the contract does not name: a client
written to the contract would omit it and be rejected. Descriptions and directives are not compared.
A member declared twice in the contract with two signatures is reported as the contract
contradicting itself.

Each violation names the divergent signature and the contract line, and under GitHub Actions is also
an error annotation on that line. The pull-request workflow runs it as its own unconditional job;
the project's `test` target runs the same assertion. Editing the contract or the schema does not
make this project affected, so `nx affected` will not run it — that is why the CI job is unconditional.
