# azurecvm (vendored)

A verbatim copy of `Super-Protocol/sp-nodejs-addons` →
`attestation-wasm/go/azurecvm` at commit `00f8485` (sp-nodejs-addons#43, the TD
quote v5 fix of SUP-768; re-point this to the squash commit on `main` once that
PR lands): the Azure confidential-VM verifier the browser extension's
WebAssembly build runs. Keeping every file byte-identical to upstream is what
makes the gatekeeper and the extension derive the same mrEnclave from the same
Azure root — and keeps that checkable by blob hash.

Do not edit these files here. Change them upstream, then re-copy every file
(including `testdata/` and `azure-vtpm-root-ca-2023.pem`) and update the commit
above. `golangci-lint` and Biome exclude this directory for the same reason
(`libs/swarm-evidence-go/.golangci.yml`, root `biome.json`).

This module's own glue — the hardware-signature checks and the key binding —
lives in `../../azure.go`.
