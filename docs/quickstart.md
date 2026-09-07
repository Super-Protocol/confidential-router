# Quickstart

Ten minutes from a clone to a verified generation: a router serving a model, a
gatekeeper that refuses to talk to it until it has checked what it is, and an
OpenAI SDK call that goes through anyway.

Nothing here is attested for real. The model is a mock, the TEE quote is a
fixture blob, and the "cloud" root is minted on your machine. What *is* real is
every mechanism between them — the evidence contract, the verification pipeline,
the pin policy, the metering and the billing.

- [The two-command version](#the-two-command-version)
- [By hand](#by-hand)
- [The part worth watching: fail-closed](#the-part-worth-watching-fail-closed)
- [With Docker instead](#with-docker-instead)
- [Where to go next](#where-to-go-next)

## Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | see `.nvmrc` (24) | the router, the console, the stand-ins |
| pnpm | 11 | the workspace |
| Go | 1.26 | the gatekeeper |
| Docker | any recent | only for [the compose route](#with-docker-instead) |

```bash
git clone https://github.com/Super-Protocol/confidential-router.git
cd confidential-router
pnpm install
```

## The two-command version

```bash
pnpm demo
```

That is the whole story, scripted and checked: it starts the model backend, the
router and the evidence publisher, configures a gatekeeper from nothing, pins
what the endpoint publishes, sends an OpenAI SDK call through it, redeploys the
endpoint behind its back, shows the next call being refused, and then pins the
new digest and watches traffic resume. It takes a few seconds and exits non-zero
if any step does not hold — it is what CI runs.

`tools/demo/src/story.ts` is the script. The rest of this page is the same
sequence typed out, because the commands are the point.

## By hand

### 1. Start the router and its neighbours

```bash
pnpm exec tsx tools/demo/src/serve.ts
```

This brings up three processes' worth of stack behind one command:

| What | Where | Standing in for |
| --- | --- | --- |
| `router-api` | `http://127.0.0.1:3000` | itself — the built artefact |
| `tools/mock-litellm` | an ephemeral port | LiteLLM in the confidential cluster |
| `tools/mock-evidence-host` | an ephemeral HTTPS port | the platform publishing `/.well-known/swarm-evidence` |

It prints a handoff file (`test-output/demo-stack.json`) holding the session
cookie, the workspace id and an API key — it has already signed a user in,
bought $20 of credit through the manual payment provider and minted a key,
because doing that by hand is the least interesting part of this page.

```bash
stack() { node -p "require('$PWD/test-output/demo-stack.json').$1"; }
API_KEY=$(stack apiKeySecret)
UPSTREAM=$(stack evidenceHostUrl)      # the attested face of the router
ROOT_PEM=$(stack trustedRootFile)
```

The router answers already, without a gatekeeper:

```bash
curl -s http://127.0.0.1:3000/v1/models -H "authorization: Bearer $API_KEY" | jq '.data[].id'
```

That works, and it proves nothing about what is on the other end. Which is the
point of everything below.

### 2. Build the gatekeeper

```bash
pnpm nx run gatekeeper:build     # → apps/gatekeeper/bin/gatekeeper
alias gatekeeper=$PWD/apps/gatekeeper/bin/gatekeeper
export CR_GATEKEEPER_CONFIG=$PWD/.tmp/gatekeeper.yaml
```

### 3. Configure it from nothing

```bash
gatekeeper init
```

The file it writes is deliberately not runnable: no endpoints. There is no
trust-on-first-use anywhere in this product.

The demo stack's root is a throwaway CA on your own machine, not a TEE-attested
Swarm root, so it has to be trusted by hand — which is also how you would pin a
single cloud in production. Against a real Swarm cloud this step is not needed:
the gatekeeper checks the root's own hardware evidence instead
(`docs/gatekeeper.md`, "Roots that prove what they are").

```bash
gatekeeper trust roots add swarm-cloud-demo --pem-file "$ROOT_PEM"
```

Then the endpoint — a local port, and the router hostname behind it:

```bash
gatekeeper endpoint add router --listen 127.0.0.1:8443 --upstream "$UPSTREAM"
```

It warns you, correctly, that the endpoint has no pinned digest and cannot admit
anything yet.

### 4. Look at what the endpoint publishes, then pin it

```bash
gatekeeper endpoint discover router
```

This runs the whole pipeline once — fetch the bundle, validate the chain, match
a trusted root, verify the JWS and its freshness, bind the verdict to the TLS
certificate it saw itself — and prints what it found: the chain, the TEE quote
format, the container images in the deployment snapshot, and the
`evidenceDigest`. Read it. That digest is the thing you are about to trust.

```bash
gatekeeper endpoint trust add router --from-upstream
```

`--from-upstream` is not trust-on-first-use: it verifies first, shows you the
report, and asks before writing. A bundle that fails any stage is never pinned.

```bash
gatekeeper config validate     # → valid and ready to run
```

### 5. Run it, and send a request through

```bash
gatekeeper run
```

With a terminal you get the dashboard; `--headless` streams log lines instead,
which is what a container wants.

In another shell — one base-URL swap, nothing else:

```python
from openai import OpenAI

client = OpenAI(api_key=API_KEY, base_url="http://127.0.0.1:8443/v1")
print(client.chat.completions.create(
    model="meta/llama-3.3-70b-instruct:tdx",
    messages=[{"role": "user", "content": "Is this endpoint attested?"}],
).choices[0].message.content)
```

The answer comes back, and the console's Activity and Logs screens now show the
generation, its token counts and what it cost.

## The part worth watching: fail-closed

Everything above is a happy path. This is the one that matters.

Redeploy the endpoint — a new image, a new deployment snapshot, and therefore a
new `evidenceDigest`, still perfectly signed by the same cloud:

```bash
curl -sk "$UPSTREAM/__mock/rotate-deployment"
```

(That control surface belongs to `tools/mock-evidence-host` and exists only so
the deny paths are reachable on demand. A real platform has no such endpoint.)

Wait for the gatekeeper's next re-attestation (`reattestInterval`, 5 minutes by
default — pass `--reattest-interval 2s` if you do not want to wait) and send the
same request again:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8443/v1/chat/completions \
    -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' \
    -d '{"model":"meta/llama-3.3-70b-instruct:tdx","messages":[{"role":"user","content":"hi"}]}'
503
```

```jsonc
{
  "error": { "message": "policy: the built-in pin policy (gatekeeper.default) denied", … },
  "stage": "policy",
  "reason": "the built-in pin policy (gatekeeper.default) denied"
}
```

Nothing reached the router. The connection the old verdict admitted was closed
the moment the verdict flipped. `stage` says which check refused, so an operator
does not have to guess whether this is a rotation, an expiry or an attack.

Accept the new deployment, and traffic resumes:

```bash
gatekeeper endpoint trust add router sha256/<the new digest>
kill -HUP $(pgrep -f 'gatekeeper.*run')     # or restart it
```

A rollout is pinned *before* it lands, not after: pin the new digest next to the
old one, deploy, then unpin the old one. Nothing is ever refused in between.

## With Docker instead

The compose stack runs the same shape with the console attached:

```bash
pnpm stack:up          # docker compose --profile demo up -d --build --wait
```

- console `http://localhost:3001`, API `http://localhost:3000`
- sign in with a magic link: submit an address, then read the URL out of
  `docker compose -f docker/docker-compose.yml logs api`
- the demo root CA is at `http://localhost:8081/roots/demo-root.pem` — that is
  what you `gatekeeper trust roots add`, because a local throwaway CA has no
  hardware evidence for the gatekeeper to check

`pnpm stack:down` when you are done. Read `docker/README.md` before borrowing
any of it: the credentials are committed and the API runs outside production
mode on purpose.

## Where to go next

- [`docs/gatekeeper.md`](gatekeeper.md) — configuration, the Rego model and
  policies worth writing
- [`docs/router.md`](router.md) — the router's own configuration: models,
  LiteLLM, endpoints, Stripe
- [`docs/threat-model.md`](threat-model.md) — what a verified verdict does and
  does not mean
- [`docs/adr/`](adr/) — why the architecture is what it is
