# Gatekeeper

The gatekeeper is a forward proxy you run on your own machine. It verifies what
a Confidential Router endpoint publishes about itself, and only then lets your
traffic through. Verification happens here, on your side: the router never
learns whether, when, or by whom it was attested (ADR-002).

One base-URL swap is the whole integration:

```python
client = OpenAI(api_key=KEY, base_url="http://127.0.0.1:8443/v1")
```

- [Install](#install)
- [The commands, in the order you need them](#the-commands-in-the-order-you-need-them)
- [Configuration](#configuration)
- [What a verdict is made of](#what-a-verdict-is-made-of)
- [Denials](#denials)
- [Policies](#policies)
- [Operating it](#operating-it)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Super-Protocol/confidential-router/main/tools/installer/install.sh | sh
```

Or take a static binary and its checksum from
[Releases](https://github.com/Super-Protocol/confidential-router/releases).
From a clone: `pnpm nx run gatekeeper:build` → `apps/gatekeeper/bin/gatekeeper`.

## The commands, in the order you need them

```bash
gatekeeper init                                             # write a starter config
gatekeeper endpoint add <name> --listen 127.0.0.1:8443 \
                               --upstream https://<host>    # add a listener
gatekeeper endpoint discover <name>                         # look at what it publishes
gatekeeper endpoint trust add <name> --from-upstream        # pin it, after review
gatekeeper config validate                                  # ready to run?
gatekeeper run                                              # dashboard, or --headless

gatekeeper trust roots add <cloud> --pem-file root.pem      # optional: pin one cloud
```

There is no `trust roots add` in the usual path, because a Swarm cloud's
certificate authority proves what it is: it runs in a TEE, its certificate
carries that hardware evidence, and the gatekeeper checks it (below). Add a root
by hand to accept exactly one cloud and nothing else, or to trust a CA that
publishes no evidence.

`init` writes a file that is deliberately **not runnable**: no trusted roots, no
endpoints, no pins. There is no trust-on-first-use anywhere in this product, and
`config validate` will keep telling you what is still missing.

`--from-upstream` is not an exception to that. It runs the full pipeline, prints
the report, and asks before writing; a bundle that fails any stage is never
pinned. What it does *not* check is whether the deployment it found is one you
want — that is the question you are answering by saying yes.

An unfinished file is not a broken one. Every command above except `run` reads
it happily — that is how the file gets finished, and `endpoint add` writes an
endpoint with no pins on purpose so that `endpoint trust add --from-upstream`
can supply the first one. Only `run` insists the configuration is complete,
because only `run` can admit traffic.

Every command takes `--json`, and every one exits with a meaningful status:

| Exit | Meaning |
| --- | --- |
| 0 | fine |
| 1 | something went wrong |
| 2 | you typed it wrong |
| 3 | verified, but not admitted (`verify`, `endpoint trust add --from-upstream`) |
| 4 | the configuration is missing, invalid or unfinished |
| 69 | the capability is not wired into this build (`EX_UNAVAILABLE`) |

## Configuration

`~/.config/confidential-gatekeeper/config.yaml` by default; `--config` or
`$CR_GATEKEEPER_CONFIG` override it. Normative schema:
`schemas/gatekeeper-config.schema.json`. The `trust` and `endpoint` commands
edit this file in place and keep your comments.

```yaml
version: 1

# "Trusted Clouds". A bundle is accepted if its certificate chain ends in one of
# these, matched by the SHA-256 of the root's DER — a root identifies a cloud,
# not a deployment. May be empty, because of `attestedRoots` below.
trustedRoots:
  - name: swarm-cloud-prod
    pemFile: ./roots/swarm-cloud-prod.pem     # or an inline `pem:` block

# ...or the root proves it is a Swarm root on its own. On by default; these are
# the defaults written out.
attestedRoots:
  enabled: true
  requireNetworkType: any   # `trusted` also requires the root to say so
  cacheTtl: 10m             # how long one root's verdict is reused
  checkRevocations: false   # also consult the CPU vendor's CRLs (needs network)

# Rego modules, ANDed with the built-in pin policy. A policy can narrow trust,
# never widen it.
policies:
  - name: images-from-our-registry
    file: ./policies/images.rego

# Inherited by every endpoint unless it overrides them.
defaults:
  failMode: closed          # `open` is an explicit, per-endpoint opt-in
  reattestInterval: 5m      # background re-verification
  verdictCacheTtl: 60s      # how long an on-demand re-check reuses a verdict
  maxBundleAge: 24h         # a bundle older than this is stale
  initialTimeout: 15s       # how long the first request waits for a verdict

endpoints:
  - name: llama-33-70b
    listen: 127.0.0.1:8443
    upstream: https://llama-33-70b.tee.swarm.cloud
    trustedEvidence:
      - sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs
    # Any `defaults` key may be repeated here for this endpoint alone.
    reattestInterval: 2m

log:
  level: info
  format: text            # `json` for a log shipper

# Local status API, so `gatekeeper status` in one terminal can report on a
# `gatekeeper run` in another. Loopback or unix socket only: it carries verdicts.
admin:
  listen: unix:/run/user/1000/gatekeeper.sock

# One JSON object per line: every verdict and every blocked request. Request and
# response bodies are never written to it.
audit:
  file: ~/.local/state/confidential-gatekeeper/audit.log

# Prometheus, off unless set.
metrics:
  listen: 127.0.0.1:9464
```

Every tuning knob also has an environment override, globally
(`CR_GATEKEEPER_REATTEST_INTERVAL`) or per endpoint
(`CR_GATEKEEPER_ENDPOINT_LLAMA_33_70B_FAIL_MODE`). Precedence, weakest first:

```
built-in defaults → the file → CR_GATEKEEPER_* → command-line flags
```

### `trustedEvidence` — what you are actually pinning

An `evidenceDigest` is the SHA-256 of the canonical deployment snapshot: the
images, their digests and the measurements that make up one deployment. Pinning
one says "this exact deployment, and no other". Canonical form is
`sha256/<base64url>`; `sha256:<hex>` and bare hex are accepted on input and
normalised on write.

The list is plural so a **rollout can be pre-approved**: pin the new digest next
to the old one, deploy, then unpin the old one. Nothing is refused in between.
An endpoint with an empty list can never admit anything, and says so.

## What a verdict is made of

```
fetch → cert-chain → untrusted-root → jws (+ freshness) → tls-fingerprint → policy
```

1. **fetch** — `GET https://<host>/.well-known/swarm-evidence`, HTTP/1.1 only,
   no redirects, no connection reuse.
2. **cert-chain** — the bundle's `certChain` is validated leaf → root.
3. **untrusted-root** — the root must be one of your `trustedRoots`, by
   fingerprint, **or** it must prove it is a Super Swarm root (see below).
4. **jws** — the payload's signature (RS256 or ES256K) is checked against the
   chain leaf, and `issuedAt` against `maxBundleAge`.
5. **tls-fingerprint** — the signed `certFingerprint` is compared with the leaf
   the gatekeeper **observed on the very connection the bundle arrived over**.
   That is what binds the deployment's claim to this channel; the gatekeeper
   never accepts a producer-asserted binding.
6. **policy** — the built-in pin policy and every user policy must allow.

The handshake deliberately does not consult your system trust store: trust is
decided by that chain terminating at a root you configured or the gatekeeper
attested, plus the fingerprint comparison. Swarm Cloud roots are not publicly
trusted, and a system-pool check would reject every healthy endpoint while
adding nothing.

## Roots that prove what they are

A Super Swarm Root CA runs inside a confidential VM, and its certificate carries
what that VM attested. When the chain ends in a root you never listed, the
gatekeeper checks that evidence rather than giving up:

1. the hardware report has to verify against the CPU vendor's own root — AMD's
   ARK for SEV-SNP, Intel's chain for TDX — with the certificates the evidence
   carries;
2. the report's `reportData` has to commit to *this* certificate's public key,
   so the attestation is about this CA and not merely about some VM;
3. the VM's launch measurement is rebuilt from the published `sp-vm` build
   artefacts, has to reproduce the measurement the hardware signed, and is then
   normalised to a value that does not depend on vCPU count or RAM size;
4. that measurement has to carry a Super Protocol signature, checked against a
   key **pinned in the gatekeeper binary**. Step 4 is what makes the chain
   closed: without it, any tenant of any AMD host could produce steps 1–3.

`gatekeeper verify` prints all of it:

```
Root certificate TEE evidence
  Verdict             attested — this is a Super Swarm root
  Evidence type       AMD SEV-SNP (QEMU)
  Report integrity    ok
  Chain revocation    not checked
  CPU generation      Genoa
  SNP firmware TCB    27
  Debug mode          disabled
  Ciphertext hiding   disabled
  Page swap disabled  disabled
  Network type        untrusted
  Measurement         842c5f2e… (in trusted registry)
  Key binding         676553c0… (matches the report data)
```

Two things the gatekeeper deliberately does **not** decide for you. The TEE
flags — debug, ciphertext hiding, page-swap — are reported, never enforced;
require what you want in Rego, through
`input.attestation.rootAttestation.teeFlags`. And "network type", which is the
platform's own trusted/untrusted network split rather than a judgement about the
CA: today's Swarm Cloud root says `untrusted`, so the default accepts either and
tells you which. Set `attestedRoots.requireNetworkType: trusted` to insist.

The check fails closed. A registry that cannot be reached, artefacts that cannot
be downloaded, an evidence type this build does not know: all deny, with the
reason appended to the untrusted-root denial. Manually pinned roots keep working
with no network at all, which is the offline escape hatch —
`attestedRoots.enabled: false` turns the whole path off.

## Denials

A request that arrives without a valid verdict, under the default
`failMode: closed`, is answered by the gatekeeper itself. Nothing reaches the
upstream, and any connection the previous verdict admitted is closed.

```jsonc
// HTTP 503
{
  "error": {
    "message": "policy: the built-in pin policy (gatekeeper.default) denied",
    "type": "gatekeeper_error",
    "code": "attestation_failed"
  },
  "stage": "policy",
  "reason": "the built-in pin policy (gatekeeper.default) denied"
}
```

`error` is OpenAI-shaped so a client library surfaces the message rather than a
bare status. `stage` and `reason` sit beside it because "which check failed" is
the operational question, and it should not require parsing prose. The same
string is on every response as `X-Gatekeeper-Verdict`.

| `stage` | What happened |
| --- | --- |
| `fetch` | the endpoint did not serve a usable bundle |
| `cert-chain` | its chain is malformed, expired or does not chain up |
| `untrusted-root` | the chain ends somewhere you never trusted |
| `jws` | bad signature, wrong payload, or a stale/future bundle |
| `tls-fingerprint` | the signed certificate is not the one on this connection |
| `policy` | verified, but a policy said no — usually an unpinned digest |

`failMode: open` proxies anyway, logs at warn, and marks the response. It is a
per-endpoint opt-in and it is not a default for a reason.

## Policies

The gatekeeper generates a trust module from your configuration and loads a
built-in policy over it. Every user policy is **ANDed** with that, so a policy
can only narrow what is admitted:

```
admitted ⇔ pipeline verified ∧ gatekeeper.default.allow ∧ every user allow
```

A package without `allow` fails to load; an error or an undefined result is a
deny. The full `input` document is `docs/contracts/rego-input.md`.

### The built-in policy

```rego
package gatekeeper.default

default allow := false

allow if {
  input.attestation.verified == true
  some digest in data.gatekeeper.trust.endpoints[input.endpoint].evidence_digests
  digest == input.evidence.evidenceDigest
}
```

### Multiple digests, one endpoint

Nothing extra is needed for the common case — `trustedEvidence` is already a
list, and the built-in policy accepts any member of it. A policy is worth
writing when the *rule* is more than a list. For example, accepting a rollout
only while it is in flight:

```rego
package user.rollout

import rego.v1

# The digest we are migrating to, and the one we are migrating from. Both are
# pinned in the config; this narrows the old one to a deadline.
current := "sha256/kR-S9pBaadyOX2W_-0OXhernK102Y7P-N0ee_fDA9jU"
previous := "sha256/weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs"
previous_accepted_until := time.parse_rfc3339_ns("2026-09-15T00:00:00Z")

default allow := false

allow if input.evidence.evidenceDigest == current

allow if {
  input.evidence.evidenceDigest == previous
  time.parse_rfc3339_ns(input.attestation.verifiedAt) < previous_accepted_until
}
```

### Image digests

`input.evidence.containerImages` is every `image` string in the deployment
snapshot, flattened and deduplicated. This is the policy most operators
actually want:

```rego
package user.images

import rego.v1

default allow := false

# Every image must come from our registry and be pinned by digest. A tag is not
# an identity: `:latest` can mean something different tomorrow.
allow if {
  count(input.evidence.containerImages) > 0
  every image in input.evidence.containerImages {
    startswith(image, "ghcr.io/super-protocol/")
    contains(image, "@sha256:")
  }
}
```

Or an allow-list of exact images, which is what a regulated deployment tends to
end up with:

```rego
package user.images_allowlist

import rego.v1

approved := {
  "ghcr.io/super-protocol/router-api@sha256:1111111111111111111111111111111111111111111111111111111111111111",
  "ghcr.io/berriai/litellm@sha256:2222222222222222222222222222222222222222222222222222222222222222",
}

default allow := false

allow if {
  count(input.evidence.containerImages) > 0
  every image in input.evidence.containerImages { approved[image] }
}
```

### Matching into the snapshot

`custom.tree_match(pattern, actual)` is true when every key in `pattern` is
present in `actual` with an equal value; keys only in `actual` are ignored. It
exists because deployment snapshots are deep and mostly irrelevant to any one
rule, and writing "these few fields must look like this" with `walk()` is
verbose and easy to get subtly wrong.

```rego
package user.measurements

import rego.v1

default allow := false

allow if {
  custom.tree_match(
    {"measurements": {"mrtd": "6b1f9c04…"}},
    input.evidence.evidence,
  )
}
```

### Testing a policy offline

```bash
gatekeeper policy test --bundle ./bundle.json --config ./config.yaml --endpoint llama-33-70b
```

Same evaluation, no network, per-package results. `gatekeeper verify <endpoint>
--json` gets you a bundle to feed it.

## Operating it

- **`gatekeeper run`** opens the dashboard when it has a terminal; `--headless`
  streams log lines, which is what a container or a systemd unit wants.
- **SIGHUP** reloads the configuration in place. A reload that fails to load or
  validate changes nothing — a typo must not take the proxy down.
- **SIGINT / SIGTERM** drain the listeners (`--drain-timeout`, 30s) and exit.
- **`gatekeeper status`** reports on a gatekeeper running in another process,
  through the `admin` socket. Without an `admin:` section there is nothing to
  report on, and it says so rather than looking broken.
- **The audit log** is one JSON object per line: every verdict and every blocked
  request, never a request or response body.

## See also

- [`docs/quickstart.md`](quickstart.md) — the whole flow in ten minutes
- [`docs/threat-model.md`](threat-model.md) — what a verdict does and does not mean
- [`docs/adr/ADR-003-gatekeeper-trust-model.md`](adr/ADR-003-gatekeeper-trust-model.md) — why it is shaped this way
- [`docs/contracts/rego-input.md`](contracts/rego-input.md) — the `input` document, field by field
- [`apps/gatekeeper/README.md`](../apps/gatekeeper/README.md) — building and hacking on it
