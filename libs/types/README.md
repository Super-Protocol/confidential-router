# @confidential-router/types

Shared TypeScript contracts for the Confidential Router: API DTOs, config
schemas and the `/.well-known/swarm-evidence` wire types that both the router
API and the console depend on.

Today it carries the evidence-digest helpers — the parser and normaliser for the
`sha256/<base64url>` value users pin per endpoint, held to the shared vectors in
`@confidential-router/attestation-fixtures`. The remaining contracts (API DTOs,
config schemas) land with the router API and console work.

The wire types of the attestation bundle itself live in
`@confidential-router/attestation`, next to the verifier that enforces them.
