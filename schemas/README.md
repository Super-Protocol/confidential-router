# Machine-readable contracts

JSON Schema (draft 2020-12) is the single source of truth for every document that crosses a language or
process boundary. TypeScript consumers import them through `@confidential-router/types`
(`libs/types/src/schemas`), the Go gatekeeper embeds `gatekeeper-config.schema.json` and
`swarm-evidence-bundle.schema.json` with `go:embed` and validates with `santhosh-tekuri/jsonschema`.

| Schema | Consumed by | Example |
| --- | --- | --- |
| `gatekeeper-config.schema.json` | `apps/gatekeeper` (`pkg/config`), docs | `examples/gatekeeper-config.example.yaml` |
| `rego-input.schema.json` | `apps/gatekeeper` (`pkg/policy`), policy authors | `examples/rego-input.example.json` |
| `swarm-evidence-bundle.schema.json` | `libs/attestation`, `apps/gatekeeper/pkg/attestation`, router evidence poller | `examples/swarm-evidence-bundle.example.json` |
| `router-config.schema.json` | `apps/router-api` (config loader) | `examples/router-config.example.yaml` |

CI: `libs/types/src/schemas/schemas.spec.ts` compiles every schema in strict mode with `ajv` and asserts
that every example validates (plus negative cases). Change a schema → update the example → the test tells
you if they disagree. Generated TypeScript types (`json-schema-to-typescript`) are a build artefact of
`libs/types`, never edited by hand.

Encoding rules shared by all schemas:

- Fingerprints and digests: `sha256/<base64url, unpadded, 43 chars>` (canonical). `evidenceDigest` pins
  additionally accept `sha256:<hex>` / bare hex on input.
- Durations: Go style (`60s`, `5m`, `24h`).
- Money: integer micro-USD (`…Micros`).
- Names: `^[a-z0-9][a-z0-9-]{0,62}$` (they become Rego object keys).
