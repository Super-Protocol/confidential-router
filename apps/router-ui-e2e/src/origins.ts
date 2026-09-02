/**
 * The two hostnames this suite serves, and why there have to be two.
 *
 * A real deployment puts the console and router-api on different hosts under one
 * domain — `console.example.com` and `api.example.com`. Cookies are keyed by
 * host and ignore ports, so a suite that ran both on `127.0.0.1` handed the
 * console every `Set-Cookie` the API sent, and each "the browser is signed in"
 * assertion passed for a reason production does not have. That is how SUP-113
 * shipped: a middleware gating on a cookie that only ever existed in the tests.
 *
 * The names share a registrable domain on purpose. Two hosts under
 * `localtest.me` are *cross-origin but same-site*, exactly like the deployment:
 * the console still cannot read the API's cookies, while the API's `SameSite=Lax`
 * session cookie still travels on the console's requests. Sibling `*.localhost`
 * names would be cross-*site* and would fail for a reason no deployment has.
 *
 * Nothing is resolved over the network: `HOST_RESOLVER_RULE` maps both names
 * inside Chromium, so the suite needs neither DNS nor `/etc/hosts`. Node is
 * never asked either — readiness probes and requests from the runner use the
 * loopback origins below.
 */
export const CONSOLE_HOST = process.env.ROUTER_UI_E2E_CONSOLE_HOST ?? 'console.localtest.me';
export const API_HOST = process.env.ROUTER_UI_E2E_API_HOST ?? 'api.localtest.me';

export const CONSOLE_PORT = Number(process.env.ROUTER_UI_PORT ?? 4300);
export const API_PORT = Number(process.env.ROUTER_API_E2E_PORT ?? 3000);

/** What the browser is pointed at, and what the console is configured with. */
export const CONSOLE_ORIGIN = `http://${CONSOLE_HOST}:${CONSOLE_PORT}`;
export const API_ORIGIN = `http://${API_HOST}:${API_PORT}`;

/** What the runner and Playwright's own readiness probes use. */
export const CONSOLE_LOOPBACK = `http://127.0.0.1:${CONSOLE_PORT}`;
export const API_LOOPBACK = `http://127.0.0.1:${API_PORT}`;

/** Chromium argument: neither name has to exist in DNS or `/etc/hosts`. */
export const HOST_RESOLVER_RULE = `--host-resolver-rules=MAP ${CONSOLE_HOST} 127.0.0.1,MAP ${API_HOST} 127.0.0.1`;

/**
 * One thing these names cost: a named http origin is not a *secure context*,
 * which `127.0.0.1` was for free, so the browser withholds `navigator.clipboard`
 * — see `mockClipboard` in `fixtures.ts`. Chromium's
 * `--unsafely-treat-insecure-origin-as-secure` does not restore it under
 * Playwright, and sibling `*.localhost` names, which would be trustworthy, are
 * cross-*site*: the API's `SameSite=Lax` session cookie would then not travel on
 * the console's requests, which is a difference from production far more
 * expensive than the clipboard.
 */
