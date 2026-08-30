# `pkg/attestation`

Go verifier for the `/.well-known/swarm-evidence` contract — the crypto half of
the gatekeeper's trust model (ADR-003 §1). It is a port of swarm-cloud
`libs/swarm-attestation` and reaches the same verdict as the TypeScript verifier
in `libs/attestation` on the same input.

```go
result := attestation.VerifyHostname(ctx, attestation.Params{
    Hostname:     "llama-33-70b.tee.swarm.cloud",
    TrustedRoots: []attestation.TrustedRoot{{Name: "swarm-cloud-prod", PEM: rootPEM}},
    MaxBundleAge: 24 * time.Hour,
})
if !result.OK {
    return fmt.Errorf("%s: %s", result.Stage, result.Reason) // stage is the ADR-003 name
}
payload, _ := result.Deployment()
fmt.Println(payload.EvidenceDigest, result.MatchedRoot.Name, result.ChannelBinding)
```

`VerifyBundle` runs the identical pipeline over a bundle you already hold — the
entry point for `gatekeeper policy test --bundle` and for the conformance
fixtures.

## The pipeline

| Stage             | What must hold                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `fetch`           | The endpoint served a bundle of the documented shape, naming the host it was fetched from.             |
| `cert-chain`      | Every certificate is inside its validity window; every issuer asserts `cA` (and `keyCertSign`, when it carries a KeyUsage) and respects its `pathLenConstraint`; each link's issuer name and signature check out; the chain terminates at a valid self-signed certificate. |
| `untrusted-root`  | That terminal certificate's SHA-256 matches a root the caller configured.                              |
| `jws`             | The compact JWS verifies under the chain's **leaf** key — RS256 with a modulus of at least 2048 bits, or ES256K — and its payload agrees with the bundle on kind and hostname. |
| `jws` (freshness) | `payload.issuedAt` is within `MaxBundleAge`, and no further into the future than `AllowedClockSkew` (60s). |
| `tls-fingerprint` | `payload.certFingerprint` is the certificate the verifier actually saw on the wire.                    |

Failure at any stage is a denial naming that stage. There is no partial success:
callers — in particular the Rego layer — never see evidence that did not clear
every gate.

## Two decisions worth knowing about

**The fetch observes the certificate it fetched over.** `Fetch` installs its own
`DialTLSContext`, records the peer's leaf certificate, disables keep-alives,
negotiates HTTP/1.1 only and refuses redirects. A fingerprint captured by a
separate handshake could belong to a different connection than the one the
bundle arrived on; this way it cannot. The handshake itself is deliberately not
checked against the system trust store — Swarm Cloud roots are not publicly
trusted, and the chain plus the fingerprint binding are what decide trust.

`rootCaTeeQuote` is carried as `json.RawMessage` on both the bundle and the
result: the verifier has no opinion about it, and the quote-verifier hook
ADR-003 §2 reserves needs the document exactly as the endpoint published it, not
one reshaped by a struct that would drop members it does not know.

**`internal/certparse` exists because `crypto/x509` cannot read these chains.**
Swarm Cloud signs with secp256k1, a curve `x509.ParseCertificate` rejects
outright — it fails before any field is readable. `certparse` reads the RFC 5280
structure with `encoding/asn1`, delegates RSA and NIST-curve keys to
`x509.ParsePKIXPublicKey`, and handles K-256 with
`github.com/decred/dcrd/dcrec/secp256k1/v4`. It is the Go counterpart of the
noble fallback in swarm-cloud's `crypto-secp256k1.ts`. No cgo; the binary builds
with `CGO_ENABLED=0`.

It is slightly stricter than `crypto/x509` in two places, both of which can only
*narrow* what is accepted, so no bundle the TypeScript verifier admits is
rejected here: the outer `signatureAlgorithm` must equal the one inside the
TBSCertificate (RFC 5280 4.1.1.2), and SHA-1 signatures are not in the accepted
set.

The RS256 modulus floor runs the other way — it exists to *stop* Go being more
permissive. `rsa.VerifyPKCS1v15` accepts a 1024-bit key; jose, and so the
TypeScript verifier, refuses RS256 below 2048 bits. Without the floor the two
would disagree on a bundle signed by an undersized leaf.

## Conformance

`libs/attestation-fixtures` is the contract. The vectors there pin a verdict for
each case, and every implementation of this contract — the TypeScript
`@confidential-router/attestation` and this package — must reproduce all of them.
`TestConformance` replays the whole manifest through `VerifyHostname`, comparing
the verdict, the decoded payload member by member, the matched root, the channel
binding and the passed-through `rootCaTeeQuote`; on a denial it checks the stage
and the `reasonContains` substring, which are the normative parts. Full reason
wording is deliberately not pinned, so the two implementations may phrase things
differently. `TestConformanceEvidenceDigest` does the same for
`evidence-digest.json`, including a sweep of the whole base64url alphabet in the
final position to prove the accepted set is exactly the sixteen characters the
vectors publish.

The vectors are read from disk (walking up to the repository root), not embedded:
`go:embed` cannot reach outside the package directory, and the fixtures live in
another workspace project.

Cases are replayed through `Params.Fetcher`, the seam that lets a caller supply
the evidence document instead of retrieving it. That keeps the whole pipeline —
including the HTTP status check — under test without a network, and it is the
same seam an offline `gatekeeper policy test --bundle` will use.

The Go tests add what the shared vectors do not cover, because it is specific to
this implementation rather than to the contract: the chain-hygiene rules
(`cA`, `keyCertSign`, `pathLenConstraint`, an issuer name that matches while the
signature does not), the envelope-shape rejections, the fetch layer's own
behaviour (observation, size limit, redirects, non-2xx, pinned-fingerprint
rotation), and the secp256k1 parser.

## What this package does not do

Trust configuration, Rego evaluation, verdict caching, re-attestation loops and
the data plane are SUP-69/71/72. `rootCaTeeQuote` is parsed and passed through,
never validated — ADR-003 §2 reserves that hook.
