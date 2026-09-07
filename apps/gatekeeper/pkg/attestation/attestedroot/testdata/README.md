# attestedroot fixtures

Real data, so that the SEV-SNP path is proven against hardware rather than
against our own expectations. None of it is secret: an attestation report, the
AMD certificates that sign it and a published signature are all things any
client of the platform downloads.

| File | What it is |
| --- | --- |
| `swarm-root-sev-snp-evidence.bin` | The serialised `TeeEvidence` of a real Super Swarm Root CA, AMD SEV-SNP on Genoa. Taken from the platform's own conformance fixture (`sp-nodejs-addons/attestation-wasm/test/sev-snp-evidence-fixture.json`), which is the same value the browser extension's panel is built from. |
| `build-350-firmware.json` | The reduced form of the `OVMF_AMD.fd` that the evidence's build boots, plus that release's kernel/initrd hashes. It is what `snpmeasure.ParseFirmware` produces, so the measurement test needs neither the 4 MiB image nor the network. |
| `registry-signature.json` | One real entry of the signed-measurement registry, so the pinned Super Protocol key is exercised against a signature the platform actually published. |

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
fetches the release manifest, the firmware and the registry entry for real, and
compares them with what is committed here. It is off by default so the rest of
the suite stays offline and deterministic.
