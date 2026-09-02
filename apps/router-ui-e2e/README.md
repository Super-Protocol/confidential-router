# router-ui-e2e

Playwright, in two halves.

```bash
pnpm nx run @confidential-router/router-ui-e2e:e2e
pnpm exec playwright test --project=chromium     # the mocked screens only
pnpm exec playwright test --project=cross-app    # the live flows only
```

## `chromium` — the screens, with the API mocked

One spec per console screen, answering GraphQL from fixtures keyed by operation
name (`src/fixtures.ts`). A screen test should fail because the screen is wrong,
not because a database is; an operation nobody mocked fails loudly rather than
returning an empty object, because a screen quietly rendering "no data" is
exactly the bug these tests exist to catch.

`accessibility.spec.ts` audits the shell, and the screens with a table, a form
or a dialog run axe over themselves — that is where contrast and labelling
regressions actually appear.

## `cross-app` — the console against a live router-api

The complement, and the thing mocking cannot do: real HTTP, a real session, real
data. It catches a query the API no longer answers the way the screen expects, a
cookie that does not travel, and — the one worth having — a key minted in the
browser that the gateway then accepts.

Playwright starts `tools/demo/src/serve.ts` as a second `webServer`: the router,
the model backend and the evidence publisher behind one command. Whatever the
browser cannot discover over HTTP (the session cookie, the workspace id) comes
from the handoff file that server writes.

It runs serially, in one worker: every case shares one router process and one
workspace, so parallel workers would fight over the same ledger.

### The fixed port

The `cross-app` project pins the router to `127.0.0.1:3000` rather than taking a
free port like every other suite here: both `webServer` commands are built when
`playwright.config.ts` loads, before either process exists to be asked what port
it got. `ROUTER_API_E2E_PORT` overrides it if something else already owns 3000 —
the console is handed the same value as `ROUTER_UI_API_ORIGIN`, so nothing has to
be rebuilt.

The router itself still binds `127.0.0.1`, and the handoff carries both addresses:
`apiBaseUrl` for a request made from Node, `apiOrigin` for the one the browser
uses. Only the browser is taught the hostnames.

## The image suite

`playwright.image.config.ts` is the one suite here that needs Docker: it runs the
*published* console image twice, with two different `ROUTER_UI_API_ORIGIN`, and
asserts the browser calls each — the acceptance test for one pinned digest
serving any origin (SUP-100). CI runs it in the job that builds the images.

```bash
make images                                              # or ROUTER_UI_IMAGE=ghcr.io/…
pnpm nx run @confidential-router/router-ui-e2e:e2e-image
```

## Recording the flows

A failing test keeps its video and, on a retry, its trace. To record every test
— which is what a review of the console flows wants — set `PLAYWRIGHT_VIDEO`:

```bash
PLAYWRIGHT_VIDEO=on pnpm exec playwright test --project=cross-app
# → test-output/playwright/router-ui/<test>/video.webm
```

## Two hostnames

Both projects serve the console and the API under **different hostnames** —
`console.localtest.me:4300` and `api.localtest.me:3000`, both mapped to loopback
inside Chromium by `--host-resolver-rules`, so nothing is resolved over the
network. `src/origins.ts` owns the values and the reasoning; `ROUTER_UI_E2E_CONSOLE_HOST`
and `ROUTER_UI_E2E_API_HOST` override them.

It is not cosmetic. Cookies are keyed by host and ignore ports, so a suite that
ran both on `127.0.0.1` handed the console every `Set-Cookie` the API sent, and
each "the browser is signed in" assertion passed for a reason production does not
have — which is how SUP-113 shipped a console that gated on a cookie only the
tests could see. The names share a registrable domain on purpose: two hosts under
`localtest.me` are cross-origin but *same-site*, exactly like a deployment, so the
API's `SameSite=Lax` session cookie still travels while staying unreadable from
the console.

The one thing it costs: a named http origin is not a secure context, so the
browser withholds `navigator.clipboard`. `mockClipboard` in `src/fixtures.ts`
stands in for it, and says why.

## Both

Run against a production build (`next start`), not `next dev`: the proxy and the
route-group layouts behave the same either way, but a dev server recompiles on
first hit and turns a smoke test into a flake. The `e2e` target builds the app
first.
