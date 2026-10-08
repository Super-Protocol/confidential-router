# attestation test data

| File | What it is |
| --- | --- |
| `swarm-root-sev-snp.pem` | A real `CN=Super Swarm Root CA` as the platform publishes it, taken from `certChain[-1]` of `https://api.router.superprotocol.com/.well-known/swarm-evidence`. It carries all three attestation extensions — challenge type `sev-snp`, network type `untrusted`, and a 5936-byte SEV-SNP `TeeEvidence` for sp-vm `build-370` — which is why `root-tee-evidence.spec.ts` is proven against hardware rather than against our own encoder. |
| `apps-448-azure-sev-snp-root.pem` | The root CA of the build-448 demo cloud (`*.conf-apps.superprotocol.dev`), from `certChain[-1]` of one of its endpoints' `/.well-known/swarm-evidence` on 2026-10-08. An Azure SEV-SNP CVM: challenge type `sev-snp-azure`, network type `trusted`, and an `amdSevSnpAzure` `TeeEvidence` (TeeEvidence field 5) — the branch SUP-251 was filed about. The gatekeeper holds the same certificate (`attestedroot/testdata/apps-448-azure-sev-snp-root.pem`). |

Nothing here is secret: a CA certificate, an attestation report and the AMD
certificates that sign it are all things any client of the platform downloads.

The `swarm-root-sev-snp.pem` fixture is pinned deliberately. The live root moves
with the platform — its extension held `build-350` before it held `build-370` —
and a test that re-fetched it would fail for reasons that have nothing to do with
this reader. The gatekeeper pins the same kind of blob for the same reason
(`apps/gatekeeper/pkg/attestation/attestedroot/testdata/README.md`).
