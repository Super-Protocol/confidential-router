# azurecvm (vendored)

A verbatim copy of `Super-Protocol/sp-nodejs-addons` →
`attestation-wasm/go/azurecvm` at commit `da2d762`: the Azure confidential-VM
verifier the browser extension's WebAssembly build runs. Keeping every file
byte-identical to upstream is what makes the gatekeeper and the extension derive
the same mrEnclave from the same Azure root — and keeps that checkable by blob
hash.

Do not edit these files here. Change them upstream, then re-copy every file
(including `testdata/` and `azure-vtpm-root-ca-2023.pem`) and update the commit
above. `golangci-lint` excludes this directory for the same reason
(`apps/gatekeeper/.golangci.yml`).

The gatekeeper's own glue — the hardware-signature checks and the key binding —
lives in `../../azure.go`.
