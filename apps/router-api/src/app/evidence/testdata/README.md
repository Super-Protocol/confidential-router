# evidence test data

| File | What it is |
| --- | --- |
| `prod-router-azure-sev-snp-root.pem` | The production router's `CN=Super Swarm Root CA`, taken from `certChain[-1]` of `https://api.router.superprotocol.com/.well-known/swarm-evidence` on 2026-10-09. An Azure SEV-SNP CVM: its `TeeEvidence` sets branch 5 (`amdSevSnpAzure`) — the deployment SUP-270 found labelled "Intel TDX + H100 CC". |
| `synthetic-tdx-azure-root.pem` | A self-signed root generated with `openssl req -x509 … -addext "0.6.9.42.840.113741.1337.6=DER:22:02:0a:00"`: a `TeeEvidence` whose only field is branch 4 (`tdxAzure`), with an empty quote inside. Only the branch number is read, so a real quote would add nothing; it stands in for a TDX stand until one is pinned. |

Nothing here is secret: a CA certificate and the attestation report it carries
are what any client of the platform downloads. Pinned rather than fetched for
the reason `libs/attestation/src/__tests__/testdata/README.md` gives.
