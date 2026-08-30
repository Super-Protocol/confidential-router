# gatekeeper

The **Gatekeeper** is the user-side half of the Confidential Router trust model:
a single static Go binary that runs on the user's machine, verifies the evidence
a router endpoint publishes at `/.well-known/swarm-evidence`, and only then
proxies traffic to it.

The router never learns whether, when, or by whom it was attested — it only
*publishes* evidence. All verdicts are formed here.

## Status

Everything up to the verdict is here: the configuration, trust store and policy
engine (SUP-69), the verification pipeline (SUP-68), and the CLI and dashboard
(SUP-72). `gatekeeper verify` runs the whole thing against a live endpoint and
tells you whether it would be let through, and why.

What is still missing is the data plane — the listeners that carry traffic
(SUP-71). `run` and `status` therefore have nothing to run or report on, say so,
and exit 69 rather than pretending. `gatekeeper run --demo` drives the dashboard
from invented data so it can be used and reviewed today; nothing it shows was
fetched or verified, and it says so on every screen.

```bash
pnpm nx run gatekeeper:build   # -> apps/gatekeeper/bin/gatekeeper
pnpm nx run gatekeeper:test    # -> go test ./...
pnpm nx run gatekeeper:lint    # -> go vet ./... && golangci-lint run
pnpm nx run gatekeeper:serve   # -> go run ./cmd/gatekeeper
```

## Commands

Every read command takes `--json`, so the gatekeeper is scriptable without
parsing tables. Advice and warnings go to stderr; stdout is the document.

| Command | What it does |
| --- | --- |
| `init` | Write a starter configuration. It is deliberately not runnable yet. |
| `config path` | Print the config file this invocation would use, and which layer decided. |
| `config validate` | Apply every rule startup applies and list all problems at once. |
| `trust roots list\|add\|rm` | The global trusted roots ("Trusted Clouds"). |
| `endpoint list\|add\|rm` | Local listeners and their upstreams. |
| `endpoint trust list\|add\|rm` | One endpoint's pinned `evidenceDigest` values. |
| `endpoint discover <endpoint>` | Show what an upstream publishes, without trusting it. |
| `verify <endpoint\|host>` | Fetch, verify and evaluate one endpoint now, and print the full report. |
| `policy list` | The Rego packages that would be evaluated (`--show-trust-module` dumps the generated one). |
| `policy test <bundle.json>` | Evaluate your policies against a saved bundle, offline. Policy-only: see below. |
| `run` | Start the gatekeeper: the dashboard, or `--headless` for a container. |
| `status` | What a running gatekeeper is doing. |
| `version` | Build identity. |

`verify` is the command that answers "would this be let through". `policy test`
answers the narrower question "do my policies say yes", offline, against a
bundle you saved — and it is deliberately **policy-only**: there is no TLS
handshake to observe offline, observed channel binding is the only binding the
gatekeeper accepts, so a run that checked the chain, the signature and the
freshness would still not be an admission. It prints `Admitted: no` whatever the
policies said, lists every check it skipped, and takes its exit status from the
policy decision.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | A failure with no more specific code. |
| 2 | Malformed command line. |
| 3 | The command ran and the answer was no — a denied verification, a bundle the policies rejected. |
| 4 | The configuration is missing or invalid. |
| 69 | The command needs a capability this build has no implementation of. |

### Signals

`run` handles `SIGHUP` by reloading the configuration in place. A reload that
fails to load or validate changes nothing and logs why: the running
configuration is a working one, and taking the proxy down for a typo would be
worse than not reloading. `SIGINT` and `SIGTERM` drain every listener
(`--drain-timeout`, default 30s) and exit 0.

## Getting started

```console
$ gatekeeper init
Wrote ~/.config/confidential-gatekeeper/config.yaml
...

$ gatekeeper config validate
~/.config/confidential-gatekeeper/config.yaml is not ready to run (2 problems):
  - endpoints: at least one endpoint is required
  - trustedRoots: at least one trusted root is required — the gatekeeper has no built-in trust

Nothing in the file is wrong — it is not finished. See `gatekeeper trust roots add`
and `gatekeeper endpoint add`.

$ gatekeeper trust roots add swarm-cloud-prod --pem-file ./roots/prod.pem
$ gatekeeper endpoint add llama-33-70b \
    --listen 127.0.0.1:8443 --upstream https://llama-33-70b.tee.swarm.cloud
$ gatekeeper endpoint discover llama-33-70b     # review what it publishes
$ gatekeeper endpoint trust add llama-33-70b --from-upstream
$ gatekeeper config validate
~/.config/confidential-gatekeeper/config.yaml is valid and ready to run
```

Every edit goes through `config.Document`, so the comments and formatting of a
hand-written file survive, and every save is atomic.

**A config can be valid without being ready.** "Valid" means nothing in the file
is wrong; "ready" additionally means it is finished — at least one trusted root,
at least one endpoint, at least one pin each. The editing commands accept an
unfinished config, because that is the only way to finish one; `config validate`
and startup are the gates. Removing the last root or the last pin is therefore
allowed and warned about rather than refused.

## Dashboard

`gatekeeper run` opens it; `gatekeeper run --demo` opens it against invented data.

```
gatekeeper  1 confidential · 1 non-confidential                                                   
~/.config/confidential-gatekeeper/config.yaml                                                     
╭────────────────────────────────────────────────────────────────────────────────────────────────╮
│  ENDPOINT          LISTEN            UPSTREAM          STATUS            LAST ATTEST   REQ/S   │
│ ────────────────────────────────────────────────────────────────────────────────────────────── │
│  llama-33-70b      127.0.0.1:8443    https://llama-3…  confidential      now           0.8     │
│  qwen25-72b        127.0.0.1:8444    https://qwen25-…  non-confidential  now           2.5     │
╰────────────────────────────────────────────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────────────────────────────────────────────╮
│ llama-33-70b  confidential                                                                     │
│                                                                                                │
│ root                    demo-root  sha256/kw3eZGpcCR…CJ9tOPFo                                  │
│ observed TLS leaf       sha256/hf1GyYDQLx…SsEbA-QE                                             │
│ signed certFingerprint  sha256/hf1GyYDQLx…SsEbA-QE                                             │
│ evidenceDigest          sha256/q6kP-YVuoi…BmHXlMPg  pinned                                     │
│ root CA TEE quote       tdx-v4 (not validated)                                                 │
│                                                                                                │
│ chain (leaf → root)                                                                            │
│   ├─ CN=llama-33-70b.tee.swarm.cloud  sha256/hf1GyYDQLx…SsEbA-QE                               │
│   ├─ CN=demo-intermediate  sha256/F4tTs2djw7…iMDCUMT4                                          │
│   └─ CN=demo-root  sha256/kw3eZGpcCR…CJ9tOPFo                                                  │
│                                                                                                │
│ images                                                                                         │
│   ghcr.io/super-protocol/vllm@sha256:8f1c...c2a1                                               │
│   ghcr.io/super-protocol/router-sidecar@sha256:41ab...9d7e                                     │
│                                                                                                │
│ …                                                                                              │
╰────────────────────────────────────────────────────────────────────────────────────────────────╯
showing detail · 2 endpoint(s)                                                                    
↑/k up • ↓/j down • s start/stop • r re-attest • t trust this deployment • ? help • q quit
```

`l` swaps the lower pane for the live log tail:

```
gatekeeper  1 confidential · 1 non-confidential                                                   
~/.config/confidential-gatekeeper/config.yaml                                                     
╭────────────────────────────────────────────────────────────────────────────────────────────────╮
│  ENDPOINT          LISTEN            UPSTREAM          STATUS            LAST ATTEST   REQ/S   │
│ ────────────────────────────────────────────────────────────────────────────────────────────── │
│  llama-33-70b      127.0.0.1:8443    https://llama-3…  confidential      now           0.8     │
│  qwen25-72b        127.0.0.1:8444    https://qwen25-…  non-confidential  now           2.5     │
╰────────────────────────────────────────────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────────────────────────────────────────────╮
│ 12:00:00 warn  qwen25-72b       verdict deny: the published evidenceDigest is not pinned       │
│ 12:00:00 info  llama-33-70b     re-attested: admitted                                          │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
│                                                                                                │
╰────────────────────────────────────────────────────────────────────────────────────────────────╯
showing logs · 2 endpoint(s)                                                                      
↑/k up • ↓/j down • s start/stop • r re-attest • t trust this deployment • ? help • q quit
```

| Key | Action |
| --- | --- |
| `↑`/`k`, `↓`/`j` | Move between endpoints; the detail pane follows. |
| `s` | Start a stopped endpoint, stop a running one. |
| `r` | Re-attest now, bypassing the verdict cache. |
| `t` | Trust this deployment: pin the digest the last verification covered. |
| `a` | Trust the root a valid-but-unknown chain ended in — twice, to confirm. |
| `l` | Swap between the detail pane and the log tail. |
| `?` | Expand the help. |
| `q`, `esc`, `ctrl+c` | Quit. |

Both writing keys are deliberately hard to misuse. `t` pins the digest the
verification actually covered, refuses on an endpoint that has not passed
verification, and refuses again if the upstream has published something new
since — the digest of an unverified bundle is not evidence of anything. `a` is
the desktop gatekeeper's "Add to trusted clouds", and it is offered only when
the chain *validated* and the trust store was the single thing missing: on any
earlier failure `certChain` is an unvalidated array whose last element nothing
has checked. Because a root is global, `a` also takes two presses.

The layout is responsive — columns are dropped as the terminal narrows, the
lower pane is dropped before the endpoints table is — and the palette is
adaptive, so it is readable on light and dark terminals alike.

### Manual checklist

The screens above are generated from the real model
(`GATEKEEPER_CAPTURE=1 go test ./pkg/tui -run TestCaptureDashboard`), so they
cannot drift from the code. What still needs a human at a terminal:

1. `gatekeeper run --demo` — the dashboard opens, endpoints move from
   `attesting` to their verdict, and the counters climb.
2. Resize the window between roughly 60 and 200 columns: no line wraps, nothing
   overflows the border, the status bar and help stay on screen.
3. Run it once in a light terminal and once in a dark one: `confidential`,
   `non-confidential` and `broken` are all legible in both.
4. `s` on a running endpoint stops it and the row turns `stopped`; `s` again
   starts it.
5. `r` re-attests; the flash reports the outcome and clears after a few seconds.
6. `t` and `a` report that the configuration is not writable — `--demo` hands
   the dashboard no trust store on purpose, because everything it would pin is
   invented. Against a real gatekeeper, `a` asks for a second press first.
7. `l` shows the log tail and the lines keep arriving; `?` expands the help
   without hiding the table.
8. `q` leaves the terminal clean — no leftover alternate screen, cursor visible.
9. `gatekeeper run --demo --headless` logs to stdout instead; `kill -HUP` on it
   logs a reload, and `ctrl+c` drains and exits 0.

## Layout

| Path                     | Purpose                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `cmd/gatekeeper/`        | Process entry point. Four lines: it maps the CLI's exit status onto the process's. |
| `pkg/`                   | All reusable logic, importable by third parties and by a future desktop shell. |
| `pkg/cli/`               | Every command, its output and its exit code. Driven end to end in tests through `cli.Run`. |
| `pkg/tui/`               | The bubbletea dashboard, over the same status model the `status` command reads. |
| `pkg/status/`            | What an endpoint's live state and one verification look like, plus the two seams the CLI and TUI are written against. |
| `pkg/config/`            | YAML configuration: load (defaults → file → env → flags), validate, and rewrite in place. |
| `pkg/trust/`             | Trusted roots and per-endpoint pinned `evidenceDigest` values. Digest spelling is decided by `pkg/attestation`, which this package delegates to. |
| `pkg/policy/`            | Embedded OPA: the generated trust module, the built-in pin policy, user policies. |
| `pkg/policy/testing/`    | Offline evaluation of a saved bundle — what `gatekeeper policy test` runs; `NewVerifier` wires the real `pkg/attestation` pipeline in. |
| `pkg/version/`           | Build identity, stamped by GoReleaser via `-ldflags`.                    |

Keeping the verification pipeline, trust store and proxy in `pkg/` (never in
`internal/`) is a deliberate constraint from the parent design: an Electron
desktop shell must be able to embed the core later.

## Trust layer

Everything here implements [ADR-003](../../docs/adr/ADR-003-gatekeeper-trust-model.md)
and the schemas in [`/schemas`](../../schemas); read those first.

### Configuration (`pkg/config`)

`~/.config/confidential-gatekeeper/config.yaml` by default
(`--config`, `$CR_GATEKEEPER_CONFIG`, or `$GATEKEEPER_CONFIG`). Values resolve
in four layers, later ones winning:

```
built-in defaults  →  the file  →  CR_GATEKEEPER_*  →  command-line flags
```

Per-endpoint knobs resolve through their own chain: built-in → `defaults:` →
the endpoint → `CR_GATEKEEPER_*` (global, then `CR_GATEKEEPER_ENDPOINT_<NAME>_*`)
→ flags. `<NAME>` is the endpoint name upper-cased with `-` replaced by `_`.
An unrecognised `CR_GATEKEEPER_*` variable is a startup error rather than a
silent no-op — a typo in a deployment unit must not leave the old value in place.

Validation reports every problem at once, each addressed by its path
(`endpoints[1].trustedEvidence[0]: is not an evidenceDigest …`). Unknown keys
are rejected: a mistyped `trustedEvidance` would otherwise mean an endpoint
running with the wrong pins.

Edits (`gatekeeper trust roots add …`, `gatekeeper endpoint add …`) go through `config.Document`, which rewrites
the file through the yaml.v3 node API — comments, key order and block scalars
survive — and saves atomically.

### Trust store (`pkg/trust`)

Global trusted roots (matched by the SHA-256 of the root DER) and, per endpoint,
the pinned `evidenceDigest` values. Digests are canonical `sha256/<base64url>`;
`sha256/<hex>`, `sha256:<hex>` and bare hex are accepted on input and
normalised, so a pin copied out of a log matches one copied out of the console.

There is one digest parser in the binary: `trust.ParseDigest` delegates to
`attestation.NormalizeEvidenceDigest`, the implementation the shared vectors in
`libs/attestation-fixtures/vectors/evidence-digest.json` are run against — both
packages iterate those vectors in their own tests. A bare base64url token with
no scheme, and a base64url spelling whose final character carries non-zero
trailing bits, are **rejected rather than normalised**: pins are compared as
exact strings, so a second spelling of the same 32 bytes would be a pin that
never fires. `sha256:<hex>` is the one spelling `pkg/trust` accepts on top of
the vectors, as config-input sugar — hex needs no scheme to be unambiguous.

`Store.Hash()` fingerprints the whole trust state and belongs in the verdict
cache key, so editing a pin takes effect on the next check instead of waiting
out the TTL.

### Policy engine (`pkg/policy`)

Embedded OPA (Rego v1) over three kinds of module:

- `gatekeeper.trust` — generated from the trust store on every load;
- `gatekeeper.default` — the built-in pin policy, always loaded;
- the user's `policies[]`.

A request is admitted only if **every** loaded package's `allow` is true, so a
user policy can narrow trust but never widen it. Compile problems — a syntax
error, a package without `allow`, a policy trying to redeclare
`gatekeeper.default` — are fatal at load. At request time an evaluation error
or an undefined result is a deny.

`pkg/policy/testing` evaluates a saved bundle offline (`gatekeeper policy test`).
Without a verifier it runs **policy-only**: the JWS payload is decoded without
checking the signature, chain or freshness, so `Result.Admitted` is false
whatever the policies said, and every shortcut is listed in `Result.Warnings`.
`Options.Verify` is the seam that makes the run a real end-to-end check.
`testing.NewVerifier(cfg, opts)` builds the default adapter over
`pkg/attestation`: the same chain → trusted root → JWS → freshness → channel
binding pipeline the data plane runs. A bundle it rejects is never admitted,
whatever the Rego policies said about the payload; weaker guarantees an offline
run had to settle for — a producer-asserted channel binding, an unenforced
`maxBundleAge` — come back in `Result.Warnings` rather than passing silently.

`custom.tree_match(pattern, actual)` is available to policies: every key of
`pattern` must be present in `actual` with an equal value, objects recurse, and
keys only in `actual` are ignored. It is a port of the Rust gatekeeper's
built-in of the same name, so policies move over unchanged.

### The two runtime seams (`pkg/status`)

The CLI and the dashboard never talk to the proxy or the verifier directly. They
are written against two interfaces in `pkg/status`:

- `Verifier` — one-shot verification of a live host. `pkg/attestation`'s pipeline
  plus the policy engine supply it.
- `Supervisor` — the running proxy's status and control surface: snapshots, an
  event stream, start/stop, re-attest. The data plane supplies it, and
  `Reloader` is the optional half of it that makes `SIGHUP` a reload instead of a
  restart.

`pkg/verifier` implements `Verifier` by joining `pkg/attestation` with
`pkg/policy`; `cli.Env` is where a build overrides either seam, which is what
lets the whole binary be exercised in tests with neither a network nor a
terminal. `status.Demo` implements both from a config alone; it is what
`run --demo` uses, and every report it produces carries a `DEMO DATA` warning so
nothing it invents can be mistaken for a verdict.

## Toolchain

Go 1.24.6 (`go.mod`, the floor OPA sets). With Go 1.21+ and `GOTOOLCHAIN=auto` (the default) an older
local Go will fetch the pinned toolchain automatically.

`golangci-lint` v2 is required for the `lint` target —
[installation instructions](https://golangci-lint.run/docs/welcome/install/).
