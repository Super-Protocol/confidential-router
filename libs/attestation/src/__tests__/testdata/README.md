# attestation test data

| File | What it is |
| --- | --- |
| `swarm-root-sev-snp.pem` | A real `CN=Super Swarm Root CA` as the platform publishes it, taken from `certChain[-1]` of `https://api.router.superprotocol.com/.well-known/swarm-evidence`. It carries all three attestation extensions — challenge type `sev-snp`, network type `untrusted`, and a 5936-byte SEV-SNP `TeeEvidence` for sp-vm `build-370` — which is why `root-tee-evidence.spec.ts` is proven against hardware rather than against our own encoder. |

Nothing here is secret: a CA certificate, an attestation report and the AMD
certificates that sign it are all things any client of the platform downloads.

The `swarm-root-sev-snp.pem` fixture is pinned deliberately. The live root moves
with the platform — its extension held `build-350` before it held `build-370` —
and a test that re-fetched it would fail for reasons that have nothing to do with
this reader. The gatekeeper pins the same kind of blob for the same reason
(`apps/gatekeeper/pkg/attestation/attestedroot/testdata/README.md`).
