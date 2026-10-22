// Reads the current deployment's own bootstrap token out of the marketplace
// that deployed it — the same value, from the same place, the operator console
// shows in its credentials dialog (SUP-438).
//
//   MARKETPLACE_ORIGIN=… MARKETPLACE_EMAIL=… MARKETPLACE_PASSWORD=… \
//   ROUTER_API_ORIGIN=…  node resolve-bootstrap-token.mjs
//
// Exits 0 and prints one JSON object on stdout — `token` and the provenance
// the caller logs — when it found exactly one live deployment serving the
// router's API hostname; exits 1 and prints the refusal, in a sentence meant
// for an operator, when it did not.
//
// The point of reading it here rather than storing it: `bootstrapToken` is a
// `generated` parameter of the deployment, so every production rebuild mints a
// new one and any copy written down becomes a 401 the moment the rebuild lands.
// The marketplace account this signs in as is not deployment-scoped, so it
// survives what the token does not.
//
// The deployment is found by hostname, not by id, for the same reason: a
// rebuild is a *new* deployment row serving the same `apiHostname`, so an id
// pinned in a config file goes stale exactly as the token does. Pin one through
// MARKETPLACE_DEPLOYMENT_ID only when there is a reason to; the hostname has to
// match it either way, because a pin left behind on another deployment would
// otherwise hand this router somebody else's token.
//
// MARKETPLACE_ORG_ID, on the other hand, is worth setting: listing an
// organization's deployments re-syncs every one of them against its cloud, so
// an unpinned nightly run does that for every organization the account can see.

const TIMEOUT_MS = 30_000;

function refuse(message) {
  process.stdout.write(message);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value) refuse(`${name} is not set; it is needed to read the token off the deployment.`);
  return value;
}

const origin = required('MARKETPLACE_ORIGIN').replace(/\/+$/, '');
const email = required('MARKETPLACE_EMAIL');
const password = required('MARKETPLACE_PASSWORD');
const pinnedOrg = process.env.MARKETPLACE_ORG_ID ?? '';
const pinnedDeployment = process.env.MARKETPLACE_DEPLOYMENT_ID ?? '';

let apiHostname;
try {
  apiHostname = new URL(required('ROUTER_API_ORIGIN')).hostname.toLowerCase();
} catch {
  refuse(`ROUTER_API_ORIGIN is not a URL, so there is no hostname to find a deployment by.`);
}

/** Cookie pairs the marketplace set at sign-in, and the bearer token if it offered one instead. */
const session = { cookie: '', bearer: '' };

async function call(path, init = {}) {
  const url = `${origin}${path}`;
  const headers = { Accept: 'application/json', ...(init.headers ?? {}) };
  if (session.cookie) headers.Cookie = session.cookie;
  if (session.bearer) headers.Authorization = `Bearer ${session.bearer}`;

  let response;
  try {
    response = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    refuse(`the marketplace at ${origin} did not answer (${error.message}).`);
  }
  return response;
}

async function body(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // An HTML error page from a proxy in front of the marketplace is the common
    // case here, and quoting the whole of it helps nobody.
    return null;
  }
}

// --- sign in ------------------------------------------------------------------

const signIn = await call('/api/auth/sign-in/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify({ email, password }),
});

if (signIn.status === 401 || signIn.status === 403) {
  refuse(
    `the marketplace refused the sign-in of ${email} (HTTP ${signIn.status}). The account's password changed, or it was removed.`,
  );
}
if (!signIn.ok) {
  refuse(`signing in to the marketplace answered HTTP ${signIn.status}; expected 200.`);
}

// `getSetCookie` keeps the headers apart; joining the raw value would fold an
// `Expires=…, Sat …` comma into a cookie boundary and send back nonsense.
session.cookie = signIn.headers
  .getSetCookie()
  .map((header) => header.split(';', 1)[0])
  .filter(Boolean)
  .join('; ');
if (!session.cookie) {
  // The bearer plugin is the other way the same instance hands out a session,
  // and a marketplace behind a cookie-stripping proxy only has that one.
  session.bearer = signIn.headers.get('set-auth-token') ?? (await body(signIn))?.token ?? '';
}
if (!session.cookie && !session.bearer) {
  refuse('the marketplace accepted the sign-in but handed back no session, so nothing can be read with it.');
}

// --- find the deployment serving this router ----------------------------------

async function organizations() {
  if (pinnedOrg) return [{ id: pinnedOrg, name: pinnedOrg }];

  const response = await call('/api/v1/organizations');
  if (!response.ok) refuse(`listing the organizations answered HTTP ${response.status}; expected 200.`);

  const list = await body(response);
  if (!Array.isArray(list) || list.length === 0) {
    refuse(`${email} belongs to no organization on this marketplace, so it can see no deployments.`);
  }
  return list;
}

/** Deployments this account can see, each tagged with the organization it belongs to. */
async function deployments() {
  const found = [];
  for (const organization of await organizations()) {
    const response = await call(`/api/v1/organizations/${organization.id}/deployments`);
    if (response.status === 403) {
      // Skipping is right while fanning out — an account in several
      // organizations is not a member of all of them. It is wrong for an
      // organization somebody named: that would be reported two refusals
      // later as "it can see no deployments at all", and send the operator
      // looking at the hostname instead of at the membership.
      if (pinnedOrg) {
        refuse(
          `${email} is not a member of the organization MARKETPLACE_ORG_ID pins (${pinnedOrg}), so it cannot list its deployments.`,
        );
      }
      continue;
    }
    if (!response.ok) {
      refuse(`listing the deployments of ${organization.name ?? organization.id} answered HTTP ${response.status}.`);
    }
    for (const deployment of (await body(response)) ?? []) {
      found.push({ ...deployment, organizationId: organization.id });
    }
  }
  return found;
}

const all = await deployments();

if (pinnedDeployment) {
  const pinned = all.find((deployment) => deployment.id === pinnedDeployment);
  if (!pinned) {
    refuse(
      `MARKETPLACE_DEPLOYMENT_ID pins ${pinnedDeployment}, which this account cannot see. A rebuild creates a new deployment, so a pinned id goes stale exactly as a stored token does — clear it and let the hostname find the current one.`,
    );
  }
  all.length = 0;
  all.push(pinned);
}

// A deployment on its way out still answers the hostname question and holds the
// previous token; taking it would pick yesterday's deployment during a rebuild.
const live = all.filter((deployment) => deployment.status !== 'deleted' && deployment.status !== 'deleting');
// The hostname check applies to a pinned row too. A pin left behind on a
// deployment serving some *other* host would otherwise hand that deployment's
// token to this router, and the only symptom would be a 401 blaming a rebuild.
const matching = live.filter(
  (deployment) => String(deployment.parameters?.apiHostname ?? '').toLowerCase() === apiHostname,
);

if (matching.length === 0) {
  if (pinnedDeployment) {
    const pinned = all[0];
    const serves = String(pinned?.parameters?.apiHostname ?? '');
    refuse(
      serves.toLowerCase() === apiHostname
        ? `MARKETPLACE_DEPLOYMENT_ID pins ${pinnedDeployment}, which serves ${apiHostname} but is ${String(pinned?.status)} — its token belongs to a deployment on its way out. Clear the pin and let the hostname find the current one.`
        : `MARKETPLACE_DEPLOYMENT_ID pins ${pinnedDeployment}, which serves ${serves || 'no API hostname'} and not ${apiHostname}. Its token opens a different deployment, and presenting it here would read as a rebuild having rotated the token. Clear the pin and let the hostname find the current one.`,
    );
  }
  const seen = [...new Set(live.map((deployment) => String(deployment.parameters?.apiHostname ?? '')).filter(Boolean))];
  refuse(
    `no live deployment this account can see serves ${apiHostname}. ` +
      (seen.length ? `The ones it can see serve: ${seen.join(', ')}.` : 'It can see no deployments at all.'),
  );
}

// Several rows can answer to one hostname, and they do in production: on
// 2026-10-20 three `confidential-router` deployments carried
// api.router.superprotocol.com, two of them still marked `running` — a
// deployment whose cloud was replaced under it never gets marked anything else.
// So `running` alone does not identify the live one. Among those still claiming
// to run, the newest is; and a newest that is `failed` loses to a `running`
// predecessor still serving the name, which is why status ranks before age.
const rank = (deployment) => (deployment.status === 'running' ? 0 : 1);
matching.sort((a, b) => rank(a) - rank(b) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
const chosen = matching[0];

// --- read its generated values ------------------------------------------------

const credentials = await call(`/api/v1/organizations/${chosen.organizationId}/deployments/${chosen.id}/credentials`);
if (credentials.status === 403) {
  refuse(
    `${email} may see the deployment serving ${apiHostname} but not its generated values — reading them needs the "member" role, and this account is a viewer.`,
  );
}
if (!credentials.ok) {
  refuse(`reading the deployment's generated values answered HTTP ${credentials.status}; expected 200.`);
}

const token = ((await body(credentials)) ?? []).find((entry) => entry?.id === 'bootstrapToken')?.value;
if (typeof token !== 'string' || token === '') {
  refuse(
    `the deployment serving ${apiHostname} has no bootstrapToken among its generated values. It was deployed with one supplied by hand rather than generated, so only whoever supplied it knows it.`,
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      token,
      deploymentId: chosen.id,
      organizationId: chosen.organizationId,
      appVersion: chosen.appVersion ?? '',
      status: chosen.status ?? '',
    },
    null,
    2,
  )}\n`,
);
