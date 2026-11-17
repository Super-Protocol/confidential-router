// Package swarmpolicy is the home of the relying party's policy artefacts for
// Super Swarm credential requests, and of the tests that hold them to the
// claim set they are written against.
//
// It carries no Go API. The deliverables are the two policy modules beside it
// — `rego/` for OPA and `sentinel/` for Vault Enterprise — which a bank's
// security team reads, diffs and deploys. The Go here exists only so that
// both are tested the way the rest of the repository is tested: `go test
// ./...` runs the Rego unit tests through OPA's own tester, checks that every
// claim the policy reads is one the SwarmClaims schema publishes, and runs
// the Sentinel suite when the Sentinel CLI is available.
//
// Why a policy module at all: the bank runs exactly one Verifier, bought or
// built, and nothing Super Swarm-specific may be required inside it. That
// Verifier appraises a hardware quote. Everything specific to Super Swarm —
// the membership chain, the leader's workload statement, the node's request
// envelope, the image identity derived from a normalised RTMR0 — is appraised
// by `swarm-evidence-go` and reported as SwarmClaims, and the decisions over
// those claims are taken here. That split is what keeps the bank's Verifier
// unmodified.
package swarmpolicy
