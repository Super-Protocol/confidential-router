# gatekeeper

The **Gatekeeper** is the user-side half of the Confidential Router trust model:
a single static Go binary that runs on the user's machine, verifies the evidence
a router endpoint publishes at `/.well-known/swarm-evidence`, and only then
proxies traffic to it.

The router never learns whether, when, or by whom it was attested — it only
*publishes* evidence. All verdicts are formed here.

## Status

Complete end to end: the configuration, trust store and policy engine (SUP-69),
the verification pipeline (SUP-68), the CLI and dashboard (SUP-72), and the data
plane that carries traffic (SUP-71). `gatekeeper run` binds a listener per
endpoint, keeps each one attested, and forwards only what its verdict admits;
`gatekeeper verify` answers the same question once, for one endpoint, without
starting anything.

`gatekeeper run --demo` still drives the dashboard from invented data, for
screenshots and for reviewing the UI without a router to point at. Nothing it
shows was fetched or verified, and it says so on every screen.

```bash
pnpm nx run gatekeeper:build   # -> apps/gatekeeper/bin/gatekeeper
pnpm nx run gatekeeper:test    # -> go test ./...
pnpm nx run gatekeeper:lint    # -> go vet ./... && golangci-lint run
pnpm nx run gatekeeper:serve   # -> go run ./cmd/gatekeeper
pnpm nx run gatekeeper:e2e     # -> the end-to-end demo (`pnpm demo`)
```

`gatekeeper:e2e` runs `tools/demo`: this binary against a real router, behind a
real evidence publisher, with a live digest rotation in the middle — the
fail-closed behaviour asserted rather than described. The script is
`tools/demo/src/story.ts`; `docs/quickstart.md` walks the same sequence by hand.

User-facing reference: [`docs/gatekeeper.md`](../../docs/gatekeeper.md) —
configuration, the verdict pipeline, denials and Rego policies. This file is
about building and hacking on it.

## Install

One static binary, no runtime dependencies — the same Linux archive runs on
glibc and on musl.

```sh
# macOS and Linux
curl -fsSL https://github.com/Super-Protocol/confidential-router/releases/latest/download/install.sh | sh
```

```powershell
# Windows
irm https://github.com/Super-Protocol/confidential-router/releases/latest/download/install.ps1 | iex
```

The script picks the archive for your OS and CPU, **verifies it against the
release's `checksums.txt`**, and installs into `/usr/local/bin` if that is
writable and `~/.local/bin` otherwise (`%LOCALAPPDATA%\Programs\gatekeeper` on
Windows, which it adds to your user PATH). `--version`, `--install-dir` and
`--help` are there when you want them; `--version nightly` installs the rolling
build of the default branch.

Or do it by hand — pick an archive from
[Releases](https://github.com/Super-Protocol/confidential-router/releases),
then:

```sh
sha256sum --check --ignore-missing checksums.txt
tar -xzf gatekeeper_<version>_linux_amd64.tar.gz
install -m 0755 gatekeeper /usr/local/bin/gatekeeper
gatekeeper version
```

Published for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64 and
windows/amd64. Nothing else is published yet — no container image, no Homebrew
tap, no deb or rpm, no signatures beyond the checksums; those are noted as TODOs
at the end of [`.goreleaser.yaml`](./.goreleaser.yaml).

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
| `status` | What a running gatekeeper is doing. Needs an `admin:` socket to reach it. |
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

## Running as a service

`gatekeeper run --headless` logs to stdout instead of opening the dashboard,
which is what a unit file and a container both want. It reloads on `SIGHUP` and
drains on `SIGTERM`, so `systemctl reload` and `systemctl stop` both do the
right thing.

`/etc/systemd/system/gatekeeper.service`:

```ini
[Unit]
Description=Confidential Router gatekeeper
Documentation=https://github.com/Super-Protocol/confidential-router
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=gatekeeper
Group=gatekeeper
ExecStart=/usr/local/bin/gatekeeper run --headless --config /etc/confidential-gatekeeper/config.yaml --log-format json
# SIGHUP reloads in place; a reload that fails to validate changes nothing.
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5s
# Longer than --drain-timeout (30s by default), so a graceful shutdown finishes
# before systemd reaches for SIGKILL.
TimeoutStopSec=45s

# Everything below is what the gatekeeper does *not* need. It reads one config
# file, opens listeners, and appends to its audit log; it never writes to the
# configuration it is running, and holds no key of its own.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
# For `audit.file`; drop it if the endpoint has no audit log configured.
LogsDirectory=confidential-gatekeeper
# For a `unix:` admin socket under /run/confidential-gatekeeper.
RuntimeDirectory=confidential-gatekeeper

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gatekeeper
sudo install -d -o gatekeeper -g gatekeeper /etc/confidential-gatekeeper
sudo -u gatekeeper gatekeeper --config /etc/confidential-gatekeeper/config.yaml init
# ... add roots, endpoints and pins, then:
sudo -u gatekeeper gatekeeper --config /etc/confidential-gatekeeper/config.yaml config validate
sudo systemctl enable --now gatekeeper
```

The unit is deliberately unprivileged: the listeners in the starter config are
loopback ports above 1024, so nothing here needs `CAP_NET_BIND_SERVICE`. If you
move an endpoint onto :443, add
`AmbientCapabilities=CAP_NET_BIND_SERVICE` rather than running as root.

Because `ProtectSystem=strict` makes the whole filesystem read-only, the editing
commands (`trust roots add`, `endpoint add`, and the dashboard's `t` and `a`
keys) cannot be run *through* the unit; edit the file directly, or as the
`gatekeeper` user, and `systemctl reload gatekeeper`.

## Releases

Tag `gatekeeper-v<semver>` and push it.
[`.github/workflows/release-gatekeeper.yml`](../../.github/workflows/release-gatekeeper.yml)
runs the same Go checks the PR gate runs, then GoReleaser
([`.goreleaser.yaml`](./.goreleaser.yaml)) cross-compiles the five static
targets, writes `checksums.txt`, and publishes a draft that the workflow flips
to a release — or to a *pre-release* when the version carries a suffix
(`gatekeeper-v0.2.0-rc.1`), so `releases/latest` keeps pointing at the last
stable build. Both install scripts ship as release assets, which is what makes
`releases/latest/download/install.sh` a stable URL.

The prefix is there because this is a monorepo and the router will get tags of
its own. GoReleaser's own monorepo support is a paid feature, so the workflow
passes the bare version in `$GATEKEEPER_VERSION` and the config templates on
that rather than on `.Version`.

`gatekeeper-nightly` is a rolling pre-release rebuilt from the default branch
each night, when it has moved. Its binaries report `nightly` as their version;
the commit and build date they also carry say which one.

To rehearse a release without publishing anything:

```sh
cd apps/gatekeeper
GATEKEEPER_VERSION=0.1.0 goreleaser release --snapshot --clean --skip=publish
```

The installers are tested on every PR against a fixture release
(`pnpm nx run installer:test`), and against a real one on Ubuntu, Alpine,
Fedora, macOS arm64 and Windows by the release workflow's `verify-install` jobs.

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
| `pkg/proxy/`             | The data plane: listeners, admission, re-attestation, the connection pools, metrics, the audit log and the admin socket. |
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
whatever the Rego policies said about the payload. A bundle that binds to its
own `tlsLeaf` is rejected too — the gatekeeper admits an observed binding only
(ADR-003 §1), so an admitted verdict needs
`VerifierOptions.ObservedTLSFingerprint` from a real handshake. What the run
merely settled for, such as an unenforced `maxBundleAge`, comes back in
`Result.Warnings` rather than passing silently.

`gatekeeper policy test` itself stays policy-only by design (see
`cli.verifyFuncFor`); the adapter is for callers that already hold an observed
fingerprint, and `gatekeeper verify` (`pkg/verifier`) is the command that
answers "would this be let through".

`custom.tree_match(pattern, actual)` is available to policies: every key of
`pattern` must be present in `actual` with an equal value, objects recurse, and
keys only in `actual` are ignored. It is a port of the Rust gatekeeper's
built-in of the same name, so policies move over unchanged.

## Data plane (`pkg/proxy`)

`gatekeeper run` binds one listener per endpoint. A request reaching one is
forwarded only if that endpoint holds a verdict admitting it; the very first
request waits for the first verdict (`initialTimeout`), and every later one is
decided against the last one the background loop produced (`reattestInterval`).
Verification never happens on the request path.

Three things make it more than a reverse proxy with a check in front:

- **The verdict is bound to a certificate, not to a hostname.** Verification
  observes the TLS leaf on its own dedicated handshake, and every proxied
  connection is held to that same leaf. A pool that presents a different
  certificate is refused with `stage: tls-fingerprint` and a re-verification is
  scheduled — which is the path a certificate rotation, or a TLS-terminating
  interceptor, takes between two background re-attestations. Connections
  admitted under the old leaf are closed, in flight or not.
- **Nothing about the verdict is ever sent upstream.** `X-Gatekeeper-*` request
  headers are stripped, and `X-Gatekeeper-Verdict` is written on the way back to
  the local client only (ADR-003 §6). The client's own `Authorization: Bearer
  sk-tee-…` passes through untouched — the gatekeeper never holds the API key.
- **Streaming is not buffered.** Responses are flushed per write, so
  `text/event-stream` reaches the client chunk by chunk; WebSocket upgrades and
  long-lived requests pass through, and no timeout bounds a response body.

Without a verdict, `failMode: closed` (the default) answers `503` with

```json
{
  "error": { "type": "gatekeeper_error", "code": "attestation_failed",
             "message": "untrusted-root: the chain terminates in …" },
  "stage": "untrusted-root",
  "reason": "the chain terminates in …"
}
```

and never opens an upstream connection. `failMode: open` forwards anyway, logs
at `warn`, tags the client-facing response `X-Gatekeeper-Verdict: deny <stage>:
<reason>`, and carries that traffic on a *separate* connection pool, so nothing
a verdict covered is ever reused for traffic it did not.

### Admin socket

`admin.listen` is `unix:<path>` or a loopback `host:port` — and only those: the
API answers with verdicts, digests and hostnames, and there is no configuration
in which publishing them to the network is what someone meant. It is read-only;
there is no route that can start, stop, pin or re-attest anything.

| Route | Answers |
| --- | --- |
| `GET /healthz` | Liveness, plus how many endpoints are configured, listening and confidential. |
| `GET /status` | The full `status.Snapshot` — the same document `gatekeeper status --json` prints. |
| `GET /endpoints` | Just the endpoint array. |
| `GET /verdicts` | One entry per endpoint: its decision and the report behind it. |
| `GET /metrics` | Prometheus. |

`metrics.listen` serves `/metrics` and `/healthz` and deliberately nothing else:
a scrape endpoint tends to end up reachable from more places than its operator
remembers, and the verdict routes name hostnames and digests.

Metrics are per endpoint: `gatekeeper_requests_total{outcome}` (allowed,
unverified, blocked, upstream-error), `gatekeeper_bytes_total{direction}`,
`gatekeeper_request_duration_seconds`, `gatekeeper_request_ttfb_seconds`,
`gatekeeper_verdict_transitions_total{from,to}`,
`gatekeeper_attestations_total{result}`, `gatekeeper_endpoint_admitted` and
`gatekeeper_endpoint_listening`. Every series exists from startup, at zero, so
"nothing was blocked" and "the endpoint does not exist" are not the same scrape.

### Audit log

`audit.file` appends one JSON object per line: every verdict change, every
request refused, and every request a `failMode: open` endpoint forwarded without
one. It records **no request or response bodies and no query strings** — the
gatekeeper carries prompts and API keys, and neither may outlive the process in
a file.

```json
{"at":"…","event":"verdict","endpoint":"llama-33-70b","admitted":true,"evidenceDigest":"sha256/…","observedTlsFingerprint":"sha256/…","root":"swarm-cloud-prod"}
{"at":"…","event":"blocked","endpoint":"llama-33-70b","admitted":false,"stage":"policy","reason":"…","method":"POST","path":"/v1/chat/completions","status":503,"failMode":"closed"}
```

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
`pkg/policy`, and `pkg/proxy` implements `Supervisor` and `Reloader`; `cli.Env`
is where a build overrides either seam, which is what lets the whole binary be
exercised in tests with neither a network nor a terminal. `status.Demo`
implements both from a config alone; it is what `run --demo` uses, and every
report it produces carries a `DEMO DATA` warning so nothing it invents can be
mistaken for a verdict.

`gatekeeper status` runs in a *different process* from `gatekeeper run`, so it
reaches the supervisor through `proxy.Client` over the admin socket. Without an
`admin:` section there is nothing to reach, and the command says so (exit 69)
rather than printing an empty table.

## Toolchain

Go 1.26.0 (`go.mod`, the floor OPA sets). With Go 1.21+ and `GOTOOLCHAIN=auto` (the default) an older
local Go will fetch the pinned toolchain automatically.

`golangci-lint` v2.13.2 or newer is required for the `lint` target —
[installation instructions](https://golangci-lint.run/docs/welcome/install/). It
has to be a build whose own Go is at least the `go` directive above: an older
one refuses to load the config rather than linting against the wrong language
version. CI pins the same floor in
[`.github/actions/go-checks`](../../.github/actions/go-checks/action.yml).
