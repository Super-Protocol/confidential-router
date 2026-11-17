# Connection link — one paste registers an external endpoint

A **connection link** is the secret output a model-serving marketplace app emits so an operator can
register it on a Confidential Router without retyping four fields. The admin section's *Add external
endpoint* dialog accepts one; the model listings produce one. This document owns the format, and
[`connection-link-vectors.json`](./connection-link-vectors.json) is the shared test vector file both
implementations are tested against — one spec, two implementations, no prose-to-prose translation.

Scope addition from Denis, 2026-10-07 (SUP-226); the producer side is the stage-4 model-serving
listings (SUP-230).

## The format

```
https://<host>[:<port>]/v1#key=<apiKey>&model=<modelId>
```

- **Scheme must be `https`.** The router's egress verifies the upstream's TLS leaf against a pinned
  certificate (ADR-008 §3); an `http` base URL could never be attested, so accepting one would only
  defer the refusal to a worse place.
- **Path is the OpenAI-compatible surface.** A trailing `/v1` is stripped: `ExternalEndpoint.baseUrl`
  is the origin, and the router appends the `/v1` paths itself (`docs/contracts/data-model.md`). Any
  other non-empty path is kept as a prefix, so an app served under `/api` still works.
- **Key material lives in the fragment and nowhere else.** A fragment is never sent to a server, so
  it stays out of access logs, out of `Referer` headers and out of proxy traces. The query string has
  none of those properties, so a link carrying `?key=` / `?api_key=` / `?token=` is **refused**
  (`key_in_query`) rather than quietly accepted — the credential in it must be treated as already
  disclosed.

### Parsing the fragment

The fragment is a `&`-separated list of `name=value` pairs. Both halves are percent-decoded with
`decodeURIComponent`, and **`+` is a literal plus, not a space** — the one place a reader must not
reach for `URLSearchParams`, whose `application/x-www-form-urlencoded` rules would silently corrupt
every API key containing a `+`.

| name | required | meaning |
| --- | --- | --- |
| `key` | yes | the upstream's ordinary LLM API key (ADR-008 decision 3) |
| `model` | yes | the model id the upstream serves it under |
| anything else | — | ignored, so the format can grow a field without breaking old readers |

A parameter given twice is a refusal (`duplicate_param`), not a last-one-wins: two keys in one link
is a producer bug, and guessing which one was meant is how the wrong credential gets stored. An empty
value is `empty_value`.

### Refusals

Every failure is one of these, and each is a sentence the dialog can show as it is:

| reason | when |
| --- | --- |
| `not_a_url` | not parseable as a URL |
| `insecure_scheme` | anything but `https:` |
| `key_in_query` | `key`, `api_key`, `apiKey`, `token` or `access_token` in the query string |
| `missing_fragment` | no fragment at all |
| `duplicate_param` | `key` or `model` given more than once |
| `empty_value` | `key` or `model` present but empty |
| `missing_key` | no `key` |
| `missing_model` | no `model` |

## What a paste pre-fills

| field | from |
| --- | --- |
| base URL | the link's origin (+ any path that is not `/v1`) |
| model id | `model` |
| upstream API key | `key` |
| endpoint name | suggested from the hostname: lower-cased, every run of non-alphanumerics collapsed to one `-`, trimmed to 64 characters — the kebab-case shape the sidecar's endpoint key requires |

**The price is never in the link, and the admin always confirms.** Decision 4 makes per-token pricing
the router operator's call, and a producer that could set it would be setting what this deployment
charges its own users. The dialog opens pre-filled and still requires a submit.

**One field, two inputs** (SUP-249). The register dialog's single *Endpoint URL or connection link*
field tells them apart by shape: a string that parses as a link fills everything above; one that is
refused **only** as `missing_fragment` — an https URL with no `#…` — is a bare endpoint URL and starts
model discovery instead (paste the key, the router attests, then lists `/v1/models`;
`console-graphql.md` "As shipped (SUP-249)"). Every other refusal is still shown in the link's own
words. The field's help text names where links live — the model deployment's *Outputs* panel.

## Handling one

A connection link is a credential. Treat a pasted one the way the console treats a created API key:

- never put it in a URL the browser navigates to, a `history.pushState`, or an analytics event;
- the registration mutation sends the key in the request body, and no read path returns it (T15);
- the paste field is cleared — and hidden — once the fields are filled, so the secret does not sit in a
  form the next screenshot catches.
