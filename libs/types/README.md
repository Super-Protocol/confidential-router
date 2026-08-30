# @confidential-router/types

Shared TypeScript contracts for the Confidential Router: API DTOs, config
schemas and the `/.well-known/swarm-evidence` wire types that both the router
API and the console depend on.

Today it only carries the evidence-digest helpers used to smoke-test the
workspace toolchain; the real contracts land with the ADR/contracts work
(`SUP-66`) and the attestation library (`SUP-67`).
