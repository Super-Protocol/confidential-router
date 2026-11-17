// Package attestation verifies the /.well-known/swarm-evidence contract: it
// fetches an endpoint's evidence bundle, decides whether the bundle proves that
// endpoint is the confidential deployment it claims to be, and returns a typed
// verdict naming the stage of any denial.
//
// The pipeline is the one ADR-003 §1 specifies, and it is a port of swarm-cloud
// libs/swarm-attestation:
//
//	fetch ─▶ cert-chain ─▶ untrusted-root ─▶ jws ─▶ freshness ─▶ tls-fingerprint
//
// Every stage is a hard gate; a failure is a denial carrying the stage name, and
// nothing downstream (in particular, no Rego policy) ever sees unverified
// evidence. The two implementations are held to identical verdicts by the shared
// conformance vectors in libs/attestation-fixtures — see TestConformance.
//
// # Channel binding
//
// The verdict is only worth as much as the channel it is bound to. VerifyHostname
// therefore fetches the bundle and records the TLS leaf certificate of that very
// connection, then requires the signed payload.certFingerprint to be that
// certificate. Hashing the bundle's own tlsLeaf field instead — the
// producer-asserted mode — is kept for parity with verifiers that have no channel
// access, such as browser extensions; the gatekeeper never relies on it.
//
// # Trust anchoring
//
// The chain is validated leaf → root on its own terms and the terminal,
// self-signed certificate is matched against the caller's trusted roots by
// SHA-256 fingerprint. The system trust store is never consulted: Swarm Cloud
// roots are not publicly trusted, and the point of the exercise is that the user
// chose the anchor.
package attestation
