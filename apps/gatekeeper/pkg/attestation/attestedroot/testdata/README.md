# attestedroot fixtures

Real data, so that the SEV-SNP path is proven against hardware rather than
against our own expectations. None of it is secret: an attestation report, the
AMD certificates that sign it and a published signature are all things any
client of the platform downloads.

| File | What it is |
| --- | --- |
| `swarm-root-sev-snp-evidence.bin` | The serialised `TeeEvidence` of a real Super Swarm Root CA, AMD SEV-SNP on Genoa. Taken from the platform's own conformance fixture (`sp-nodejs-addons/attestation-wasm/test/sev-snp-evidence-fixture.json`), which is the same value the browser extension's panel is built from. |
| `build-350-firmware.json` | The reduced form of the `OVMF_AMD.fd` that the evidence's build boots, plus that release's kernel/initrd hashes. It is what `snpmeasure.ParseFirmware` produces, so the measurement test needs neither the 4 MiB image nor the network. |
| `apps-448-azure-sev-snp-root.pem` | The root CA of the build-448 demo cloud (`*.conf-apps.superprotocol.dev`), an Azure SEV-SNP (Genoa) CVM, as served in `certChain` of that cloud's `/.well-known/swarm-evidence` on 2026-10-08. Unlike the QEMU fixture this is the certificate itself, so the Azure path is exercised end to end, key binding included; its measurement is signed in the registry's `sev-snp-azure` folder. The Azure TDX path reuses `internal/azurecvm/testdata/tdx-evidence.json`. |
| `registry-signature.json` | One real entry of the signed-measurement registry, so the pinned Super Protocol key is exercised against a signature the platform actually published. Byte-identical to `registry/sev-snp/pre-release/mrenclave-fa768b23….json`. |
| `registry/` | A cut of the registry's real directory layout, so the lookup is tested against the paths the platform publishes under rather than against a path map we wrote ourselves. See below. |

## `registry/` — the signed-measurement registry layout

The registry is the `signatures/` tree of
[Super-Protocol/sp-vm](https://github.com/Super-Protocol/sp-vm), served raw from
`main` (`DefaultRegistryBaseURL`). Its shape is `<folder>/{latest,pre-release}/
mrenclave-<hex>.json` per platform, plus legacy flat `mrenclave-<hex>.sign` files
(raw PKCS#1 v1.5 signatures, 384 bytes) at the top from before the folders
existed. The per-cloud folders `sev-snp-azure` and `tdx-azure` are what SUP-251
taught the gatekeeper to read, and each falls back to its base technology's
folder — the same map as attestation-common's `SignatureFolderMap`.

Every file here is an unmodified copy from sp-vm at commit `4c7b2f6`
(`main`, 2026-10-09). The folders are complete where they are small and
sampled where they are not:

| Path | Entries | Why |
| --- | --- | --- |
| `sev-snp-azure/pre-release/` | all 4 (`1cccb72f…`, `376b9320…`, `74c75a0b…`, `776dda2b…`) | The Azure SEV-SNP folder. `74c75a0b…` is the build-449 image the apps-448 root fixture attests — the measurement SUP-255's acceptance criterion is about. Added 2026-09-25 … 2026-10-07. |
| `tdx-azure/pre-release/` | all 5 (`1623ad33…`, `3b87e54d…`, `5690b13a…`, `65b93fe7…`, `776dda2b…`) | The Azure TDX folder. `776dda2b…` is signed in both Azure folders. Added 2026-09-25 … 2026-10-07. |
| `sev-snp/latest/` | the only entry, `c9e14878…` (build-448-release, SUP-199) | The release channel of the base folder, which an Azure lookup falls back to. |
| `sev-snp/pre-release/` | 2 of 36: `fa768b23…` (build-152, = `registry-signature.json`), `01352080…` | |
| `tdx/latest/` | the only entry, `mrenclave-11bb.json` | As published: a two-byte test measurement with a real signature over it. The code reads it like any other entry. |
| `tdx/pre-release/` | 2 of 61: `00359cf3…`, `149b771f…` | |
| `pki-solution/latest/` | 1 of 1, `f7903ef5…` (tee-pki 1.7.9) | Another product's measurements; no evidence type reads this folder, and a test pins that. |
| `arm-v9/pre-release/` | the only entry, `mrenclave-11cc.json` | As published — and it is not valid JSON (its own description says "incorrect JSON"). Kept because the real tree has it; unreachable, like `pki-solution`. |
| `mrenclave-<hex>.sign` | 2 of 71: `0049265a…`, `00540695…` | The legacy flat layout, consulted after every folder. |

Not copied: `sev-snp-azure/latest`, `tdx-azure/latest` and `tdx-google/` do not
exist in the registry yet; the lookup probes them and gets the same 404 the
live host returns. `TestRegistryLayoutEveryEntryVerifies` checks every reachable
entry under the pinned key, so a copy that was edited on the way in fails there.

## Regenerating `build-350-firmware.json`

The descriptor is derived from a published, content-addressed artefact, so
regenerating it is deterministic:

```sh
# vm.json of the release names the bucket, the object and its sha256
curl -sL https://github.com/Super-Protocol/sp-vm/releases/download/build-350/vm.json

# fetch that object from the platform's object store, then:
GATEKEEPER_OVMF=/path/to/OVMF_AMD.fd go test ./pkg/attestation/attestedroot/internal/snpmeasure -run TestWriteFirmwareFixture -v
```

The test writes the descriptor to stdout and fails if the image does not hash
to what the release's `vm.json` claims.

## Checking the fixtures against the live sources

`GATEKEEPER_NETWORK_TESTS=1 go test ./pkg/attestation/attestedroot` additionally
fetches the release manifest, the firmware and the registry entries for real —
including the `sev-snp-azure` entry for `74c75a0b…` — and compares them with
what is committed here. It is off by default so the rest of the suite stays
offline and deterministic.
