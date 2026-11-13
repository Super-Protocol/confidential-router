# Recorded Verifier fixtures

Two recorded Verifiers, appraising **the same quote**. That is the whole
design: everything that differs between the two files is configuration, and a
delegated appraisal of the same evidence has to produce the same
`SwarmClaims` either way (SUP-648).

| file | claim names | encoding | issuer | signature |
| --- | --- | --- | --- | --- |
| `intel-trust-authority.json` | `tdx.tdx_mrtd`, `tdx.tdx_rtmr0`, … | hex, report data base64url | `https://portal.trustauthority.intel.com` | PS384 / RSA-3072 |
| `acme-ear-verifier.json` | `submods.TDX.ear.veraison.annotated-evidence.tdx.mrtd`, … | base64 | `https://verifier.acme-bank.example/ear` | ES256 / P-256 |

The second one shares nothing with the first — not a claim name, not an
encoding, not the key, not the algorithm, not the nesting. A fake that reused
Intel Trust Authority's vocabulary and key would demonstrate nothing about
swapping Verifiers, which is the property these fixtures exist to prove.

## What is real here, and what is not

Real: the claim mappings, the token shapes, the signature algorithms, the key
sets, the measurement registers, the RTMR0 event list and the replay that
normalises it, and the binding digest in the quote's report data.

Not real: the TD quote's ECDSA signature, and therefore the Intel certificate
chain over it. Nothing on the delegated path looks at either — appraising the
quote's authenticity is exactly the leg the relying party's own Verifier
performs, which is what makes this module's half testable without Intel
hardware. A vector carrying an Intel-signed quote arrives with the
demonstration stand (SUP-642); it replaces the `quote` member of these files
and nothing else.

Also not real: the signing keys. They were generated for this repository and
live in `keys/`. They sign test fixtures and nothing else — do not treat a
`PRIVATE KEY` in this directory as a secret, and do not use one anywhere a
real token is minted.

## Regenerating

```sh
SWARM_REGENERATE_FIXTURES=1 go test -run TestRegenerateDelegatedFixtures ./...
```

It reuses the keys in `keys/` when they are there, so re-recording a token
does not change which key signs it. Delete a key file to mint a new one.

`expected_mrenclave` is computed in the generator from the published formula
(`sp-vm/docs/04-vm-measurements.md`), written out there rather than taken from
the appraiser's own output — so a change to the formula, the event replay or
the claim mapping fails the vector instead of being agreed on by two paths
that drifted together.

## The live test

`TestLiveVerifierAppraisesARealQuote` runs the same configuration against a
real Verifier and a real quote. It is skipped unless the environment names
both; its doc comment has the variables. CI runs these recorded fixtures
instead, because the Intel tenant is a paid human-owned account (SUP-642).
