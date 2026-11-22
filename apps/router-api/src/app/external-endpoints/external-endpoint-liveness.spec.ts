import { describe, expect, it } from 'vitest';
import type { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import {
  type CatalogueDarkness,
  type CatalogueReach,
  type CatalogueView,
  darkCatalogueAlert,
  darkCatalogueLine,
  darknessOf,
  durationSince,
  expectedToServe,
  isOutage,
  type LivenessRow,
  litCatalogueAlert,
  livenessOf,
  type OutageThresholds,
  outageAlert,
  outageLine,
  reachabilityOf,
  recoveryAlert,
  summarise,
} from './external-endpoint-liveness.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const DIGEST = 'sha256/BvG0Yy3Ir0QKPtC1TrSPuyZZD1sdKq7Gq_a1Mv1Hs0A';
/** The shape a real sidecar refusal embeds — `external-endpoints.e2e.spec.ts` asserts it does. */
const MEASUREMENT = '74c75a0ba5f36e55548a14aa0dae0d0c9de9cd6ad041a4f6c553c996e2c579a7';

/** Production's defaults, so the thresholds under test are the ones that ship. */
const THRESHOLDS: OutageThresholds = { afterFailures: 3, afterNoSuccess: 15 * 60_000 };

function row(overrides: Partial<LivenessRow> = {}): LivenessRow {
  return {
    name: 'upstream-a',
    enabled: true,
    status: 'verified',
    lastStage: null,
    lastReason: null,
    lastCheckedAt: NOW,
    lastSuccessAt: NOW,
    notServingSince: null,
    consecutiveFailures: 0,
    upstreamUnreachable: false,
    pinnedEvidenceDigest: DIGEST,
    apiKeyCiphertext: 'v1.sealed-upstream-key',
    ...overrides,
  } as ExternalEndpoint;
}

/** The shape an import leaves: switched off, with an empty key envelope (SUP-879). */
function imported(overrides: Partial<LivenessRow> = {}): LivenessRow {
  return row({ enabled: false, status: 'disabled', lastCheckedAt: null, apiKeyCiphertext: '', ...overrides });
}

/** Nothing dark, nothing to be dark about — the default for a `summarise` case. */
const LIT: CatalogueDarkness = { dark: false, since: null, outage: false };

/** The incident this exists for: the gateway dropped the route, the fetch got EOF. */
function dark(overrides: Partial<LivenessRow> = {}): LivenessRow {
  return row({
    status: 'denied',
    lastStage: 'fetch',
    lastReason: 'fetch: EOF',
    upstreamUnreachable: true,
    notServingSince: new Date(NOW.getTime() - 31 * 60_000),
    lastSuccessAt: new Date(NOW.getTime() - 31 * 60_000),
    consecutiveFailures: 3,
    ...overrides,
  });
}

describe('reachabilityOf', () => {
  it('reports unreachable when the sidecar said the dial, handshake or read failed', () => {
    expect(reachabilityOf(dark())).toBe('unreachable');
  });

  it('believes the sidecar over the stage: a fetch the upstream answered badly is reachable', () => {
    // `Report.Unreachable` is narrower than the `fetch` stage (SUP-422): a
    // non-2xx answer to the bundle fetch, an over-sized bundle and a hostname
    // the gatekeeper refuses all stop at `fetch` while the upstream demonstrably
    // answered. An ingress serving completions while
    // `/.well-known/swarm-evidence` 502s is a plausible presentation of the
    // gateway misconfiguration behind SUP-491 — calling it "did not answer"
    // would send the operator to look at a cloud that is fine, which is this
    // module's own mis-direction pointing the other way.
    const answeredBadly = row({
      status: 'denied',
      lastStage: 'fetch',
      lastReason: 'unexpected status 502 from https://partner.example/.well-known/swarm-evidence',
      upstreamUnreachable: false,
    });

    expect(reachabilityOf(answeredBadly)).toBe('reachable');
  });

  it('calls every other refusal reachable, because something answered to be refused', () => {
    // The distinction the outage turned on: a digest nobody approved and a
    // hostname that stopped resolving rendered identically before this.
    for (const stage of ['cert-chain', 'untrusted-root', 'jws', 'tls-fingerprint', 'policy', 'digest-mismatch']) {
      expect(reachabilityOf(row({ status: 'denied', lastStage: stage }))).toBe('reachable');
    }
  });

  it('falls back to the stage only for a row that recorded no flag at all', () => {
    // A verdict projected before the column existed. The boot reset retires the
    // question within one poll of a restart, so this is a transitional answer and
    // not a second opinion.
    expect(reachabilityOf(row({ status: 'denied', lastStage: 'fetch', upstreamUnreachable: null }))).toBe(
      'unreachable',
    );
    expect(reachabilityOf(row({ status: 'denied', lastStage: 'policy', upstreamUnreachable: null }))).toBe('reachable');
  });

  it('is unknown before the first check, not reachable and not down', () => {
    expect(reachabilityOf(row({ status: 'pending', lastCheckedAt: null }))).toBe('unknown');
  });

  it('is reachable on an admission whatever the stale stage says', () => {
    expect(reachabilityOf(row({ status: 'verified', lastStage: 'fetch', upstreamUnreachable: true }))).toBe(
      'reachable',
    );
  });
});

describe('expectedToServe', () => {
  it('exempts an endpoint an operator switched off', () => {
    expect(expectedToServe(dark({ enabled: false }))).toBe(false);
  });

  it('exempts one whose deployment has never been approved', () => {
    // A registration awaiting its first `pinExternalEndpointDigest` is `pending`
    // with `digest-not-pinned` by design (SUP-252). Paging for it would have
    // meant paging once for every endpoint the two-factor upgrade touched.
    expect(expectedToServe(dark({ pinnedEvidenceDigest: null }))).toBe(false);
  });

  it('does not exempt one whose pin stopped matching', () => {
    // An unapproved redeploy. A pin exists, so this router was serving the
    // upstream a moment ago and is not now — an outage, whoever caused it.
    expect(expectedToServe(dark({ lastStage: 'digest-mismatch' }))).toBe(true);
  });
});

describe('isOutage', () => {
  it('is false while an endpoint is serving', () => {
    expect(isOutage(row(), THRESHOLDS, NOW)).toBe(false);
  });

  it('is false for a single failed check — one bad fetch is noise', () => {
    const once = dark({ consecutiveFailures: 1, notServingSince: new Date(NOW.getTime() - 60_000) });
    expect(isOutage(once, THRESHOLDS, NOW)).toBe(false);
  });

  it('trips on the configured run of failures', () => {
    const run = dark({ consecutiveFailures: 3, notServingSince: new Date(NOW.getTime() - 60_000) });
    expect(isOutage(run, THRESHOLDS, NOW)).toBe(true);
    expect(isOutage({ ...run, consecutiveFailures: 2 }, THRESHOLDS, NOW)).toBe(false);
  });

  it('trips on elapsed time even when nothing has been checked at all', () => {
    // The failure a counter cannot see: a sidecar that never answers leaves every
    // row at `pending` and increments nothing. Thirty hours of 503s looked exactly
    // like this from the counter's point of view.
    const silent = row({
      status: 'pending',
      lastCheckedAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      upstreamUnreachable: null,
      notServingSince: new Date(NOW.getTime() - 16 * 60_000),
    });

    expect(isOutage(silent, THRESHOLDS, NOW)).toBe(true);
    expect(isOutage({ ...silent, notServingSince: new Date(NOW.getTime() - 60_000) }, THRESHOLDS, NOW)).toBe(false);
  });

  it('honours a disabled threshold, each on its own', () => {
    const run = dark({ consecutiveFailures: 9, notServingSince: new Date(NOW.getTime() - 60_000) });
    expect(isOutage(run, { afterFailures: 0, afterNoSuccess: 15 * 60_000 }, NOW)).toBe(false);

    const long = dark({ consecutiveFailures: 0, notServingSince: new Date(NOW.getTime() - 48 * 3_600_000) });
    expect(isOutage(long, { afterFailures: 3, afterNoSuccess: 0 }, NOW)).toBe(false);
    expect(isOutage(long, { afterFailures: 0, afterNoSuccess: 0 }, NOW)).toBe(false);
  });
});

describe('summarise', () => {
  const read = new Date(NOW.getTime() - 5_000);

  /** A catalogue that agrees with the rows, and a pass before it that did too. */
  const reach = (routable: number, behindBefore = false, darkness: CatalogueDarkness = LIT): CatalogueView => ({
    routable,
    models: routable,
    routableModels: routable,
    disabled: 0,
    awaitingKey: 0,
    darkness,
    behindBefore,
  });

  /** The reach of a rebuilt deployment: one model registered, nothing routable. */
  const rebuilt = (darkness: CatalogueDarkness): CatalogueView => ({
    routable: 0,
    models: 1,
    routableModels: 0,
    disabled: 1,
    awaitingKey: 1,
    darkness,
    behindBefore: false,
  });

  it('calls the catalogue falling behind an outage only once it has twice', () => {
    // SUP-600. A pass reads the rows at its start and rebuilds the catalogue at
    // its end, so a write between the two — the pod booting beside this one, on
    // every rolling update — leaves them disagreeing for that one pass with
    // nothing wrong. The fault this pair names lasted the life of a pod.
    const serving = [livenessOf(row(), THRESHOLDS, NOW)];

    expect(summarise(serving, read, reach(0))).toMatchObject({ status: 'ok', serving: 1, routable: 0 });
    expect(summarise(serving, read, reach(0, true))).toMatchObject({ status: 'outage', serving: 1, routable: 0 });
  });

  it('says none when nothing is registered, so there is nothing to be wrong', () => {
    expect(summarise([], null, reach(0))).toMatchObject({ status: 'none', registered: 0, models: 0 });
  });

  it('does not say none for a deployment that holds models and routes to nothing', () => {
    // SUP-879. Every endpoint is switched off, so there is no enabled row and no
    // liveness at all — and `none` read as "nothing to be wrong" while
    // `/v1/models` answered `[]`. Below the threshold it is `degraded`, which is
    // where a booting pod sits for a poll or two.
    const fresh = summarise([], null, rebuilt({ dark: true, since: NOW, outage: false }));
    expect(fresh).toMatchObject({ status: 'degraded', registered: 0, disabled: 1, awaitingKey: 1, models: 1 });

    const sustained = summarise([], null, rebuilt({ dark: true, since: NOW, outage: true }));
    expect(sustained.status).toBe('outage');
    // And it names no endpoint, like every other answer on this route.
    expect(JSON.stringify(sustained)).not.toContain('upstream-a');
  });

  it('says unknown while no verdict has been read back', () => {
    const liveness = livenessOf(row({ status: 'pending', lastCheckedAt: null }), THRESHOLDS, NOW);
    expect(summarise([liveness], null, reach(0)).status).toBe('unknown');
  });

  it('says ok only when every enabled upstream is serving', () => {
    expect(summarise([livenessOf(row(), THRESHOLDS, NOW)], read, reach(1))).toMatchObject({
      status: 'ok',
      registered: 1,
      serving: 1,
      routable: 1,
      failing: 0,
      unreachable: 0,
      pending: 0,
      verdictsReadAt: read.toISOString(),
    });
  });

  it('says degraded for a refusal below the thresholds, and names no endpoint', () => {
    const fresh = dark({ consecutiveFailures: 1, notServingSince: new Date(NOW.getTime() - 60_000) });
    const summary = summarise([livenessOf(fresh, THRESHOLDS, NOW)], read, reach(0));

    expect(summary).toMatchObject({ status: 'degraded', failing: 1, unreachable: 1, serving: 0 });
    // Public and unauthenticated: counts, never identity (SUP-221 ruling 3).
    expect(JSON.stringify(summary)).not.toContain('upstream-a');
  });

  it('says outage once a run has crossed a threshold, with the oldest start', () => {
    const summary = summarise(
      [livenessOf(dark(), THRESHOLDS, NOW), livenessOf(row(), THRESHOLDS, NOW)],
      read,
      reach(1),
    );

    expect(summary).toMatchObject({
      status: 'outage',
      registered: 2,
      serving: 1,
      failing: 1,
      since: new Date(NOW.getTime() - 31 * 60_000).toISOString(),
    });
  });

  it('answers outage even with no verdict ever read, rather than hiding behind unknown', () => {
    const silent = row({
      status: 'pending',
      lastCheckedAt: null,
      lastSuccessAt: null,
      upstreamUnreachable: null,
      notServingSince: new Date(NOW.getTime() - 16 * 60_000),
    });

    expect(summarise([livenessOf(silent, THRESHOLDS, NOW)], null, reach(0)).status).toBe('outage');
  });
});

describe('outageLine', () => {
  it('carries everything needed to act without opening a console', () => {
    const line = outageLine(livenessOf(dark(), THRESHOLDS, NOW), NOW);

    expect(line).toContain('"upstream-a"');
    expect(line).toContain('31m');
    expect(line).toContain('3 consecutive failed check(s)');
    expect(line).toContain('the upstream did not answer');
    expect(line).toContain('stage fetch');
    expect(line).toContain('fetch: EOF');
    expect(line).toContain('503 attestation_failed');
  });
});

describe('outageAlert', () => {
  /** The facts, as the message carries them — the shape an assertion wants. */
  function factsOf(liveness: ReturnType<typeof livenessOf>): Record<string, string> {
    return Object.fromEntries(outageAlert(liveness, NOW).facts);
  }

  /** Every character the message would put in an inbox, as one string. */
  function everythingIn(alert: ReturnType<typeof outageAlert>): string {
    return [alert.title, alert.summary, alert.action, ...alert.facts.flat()].join(' ');
  }

  it('says the same thing the log line says, so the two cannot be caught disagreeing', () => {
    const liveness = livenessOf(dark(), THRESHOLDS, NOW);
    const alert = outageAlert(liveness, NOW);
    const facts = factsOf(liveness);

    expect(alert.title).toContain('upstream-a');
    expect(alert.summary).toContain('503 attestation_failed');
    // The duration is the one number both readers quote; a mail saying 31m beside
    // a log line saying 32m is how an operator learns to trust neither.
    expect(facts['Not serving for']).toBe('31m');
    expect(outageLine(liveness, NOW)).toContain('31m');
    expect(facts['Failed checks in a row']).toBe('3');
    expect(facts.Endpoint).toBe('upstream-a');
  });

  it('sends an operator to the upstream’s cloud when the upstream did not answer', () => {
    const alert = outageAlert(livenessOf(dark(), THRESHOLDS, NOW), NOW);

    // The distinction the whole feature exists for: "go fix the cloud" rather
    // than "open the console and approve a deployment".
    expect(factsOf(livenessOf(dark(), THRESHOLDS, NOW)).Upstream).toBe('did not answer at all');
    expect(alert.action).toContain('Nothing here needs approving');
  });

  it('sends them to the console when the upstream answered and was refused', () => {
    const redeployed = dark({ lastStage: 'policy', lastReason: 'digest-mismatch', upstreamUnreachable: false });
    const alert = outageAlert(livenessOf(redeployed, THRESHOLDS, NOW), NOW);

    expect(factsOf(livenessOf(redeployed, THRESHOLDS, NOW)).Upstream).toContain('refused what it answered with');
    expect(alert.action).toContain('approve the new deployment');
  });

  it('carries no hostname and no digest: mail gets forwarded, the console needs a session', () => {
    const liveness = livenessOf(dark(), THRESHOLDS, NOW);
    const alert = outageAlert(liveness, NOW);

    // SUP-221 ruling 3: upstream identity and verdict detail stay behind a
    // session. The endpoint's name is here because it is the operator's own label.
    expect(everythingIn(alert)).not.toContain(DIGEST);
    expect(everythingIn(alert)).not.toContain('sha256');
    expect(everythingIn(alert)).not.toMatch(/https?:\/\//);
  });

  it('leaves the sidecar’s own sentence out, because that is where the digest hides', () => {
    // Not a hypothetical: `external-endpoints.e2e.spec.ts` asserts that a denial's
    // `lastReason` *contains the measurement hex*, and a `fetch` refusal names the
    // URL it could not read. The first version of this mail carried the reason
    // verbatim, which quietly undid the rule the case above asserts — so this
    // feeds it a reason shaped like the real ones.
    const leaky = dark({
      lastStage: 'policy',
      lastReason: `attestedRoots.trustedMeasurements does not admit ${MEASUREMENT}; fetched https://upstream.example/.well-known/swarm-evidence`,
      upstreamUnreachable: false,
    });
    const alert = outageAlert(livenessOf(leaky, THRESHOLDS, NOW), NOW);

    expect(everythingIn(alert)).not.toContain(MEASUREMENT);
    expect(everythingIn(alert)).not.toContain('upstream.example');
    expect(everythingIn(alert)).not.toContain('trustedMeasurements');
    // The stage is the same fact in a bounded form, and it is what the operator
    // acts on — so losing the sentence must not lose the direction.
    expect(factsOf(livenessOf(leaky, THRESHOLDS, NOW))['Stopped at stage']).toBe('policy');
    expect(alert.action).toContain('timeline');
    // And the log line, which stays inside the deployment, still carries it.
    expect(outageLine(livenessOf(leaky, THRESHOLDS, NOW), NOW)).toContain(MEASUREMENT);
  });
});

describe('recoveryAlert', () => {
  it('closes the alert and says how long the run was', () => {
    const declaredAt = new Date(NOW.getTime() - 90 * 60_000);
    const alert = recoveryAlert(livenessOf(row(), THRESHOLDS, NOW), declaredAt, NOW);

    expect(alert.title).toContain('is serving again');
    expect(Object.fromEntries(alert.facts)['Was not serving for']).toBe('1h30m');
    expect(alert.action).toContain('No action needed');
  });
});

describe('durationSince', () => {
  it('is coarse on purpose: minutes, then hours, then days', () => {
    expect(durationSince(new Date(NOW.getTime() - 31 * 60_000), NOW)).toBe('31m');
    expect(durationSince(new Date(NOW.getTime() - 90 * 60_000), NOW)).toBe('1h30m');
    // The number that made the point: the outage this comes from ran 30 hours.
    expect(durationSince(new Date(NOW.getTime() - 30 * 3_600_000), NOW)).toBe('30h00m');
    expect(durationSince(new Date(NOW.getTime() - 72 * 3_600_000), NOW)).toBe('3d');
  });

  it('refuses to invent a start it does not have', () => {
    expect(durationSince(null, NOW)).toBe('an unknown period');
  });
});

describe('darknessOf', () => {
  const clock = (since: Date | null, now: Date) => ({ thresholds: THRESHOLDS, since, now });
  const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

  it('is dark when models are registered and every upstream is switched off', () => {
    // The state a rebuilt production holds: the import lands each endpoint off
    // and unkeyed, because the bundle carries no secrets.
    const dark = { models: 1, routableModels: 0 };
    expect(darknessOf([imported()], dark, clock(null, NOW))).toEqual({ dark: true, since: NOW, outage: false });

    // Still inside the threshold a minute later, and past it at sixteen.
    expect(darknessOf([imported()], dark, clock(NOW, later(1))).outage).toBe(false);
    expect(darknessOf([imported()], dark, clock(NOW, later(16))).outage).toBe(true);
  });

  it('is not dark when there is nothing to serve', () => {
    // A deployment with no external model is not failing to serve one. `none` on
    // `/health` is the honest answer and this rule must not promote it.
    expect(darknessOf([], { models: 0, routableModels: 0 }, clock(null, NOW)).dark).toBe(false);
  });

  it('is not dark while one model is routable', () => {
    expect(darknessOf([row()], { models: 1, routableModels: 1 }, clock(NOW, later(16))).dark).toBe(false);
  });

  it('stands down for an upstream the per-endpoint rule is already watching', () => {
    // One outage, one message. An enabled, approved endpoint that stopped serving
    // is `alertOnOutages`' run — and a second alert for the same failure is how an
    // operator learns to filter both.
    const watched = darknessOf([row({ status: 'denied' })], { models: 1, routableModels: 0 }, clock(NOW, later(16)));
    expect(watched).toEqual({ dark: false, since: null, outage: false });
  });

  it('speaks for an endpoint nothing is expected of, which is the whole hole', () => {
    // Enabled but never approved: `expectedToServe` exempts it by design
    // (SUP-252), so no run exists and no per-endpoint alert ever fires — while
    // the deployment serves nothing.
    const unapproved = row({ enabled: true, status: 'pending', pinnedEvidenceDigest: null });
    expect(darknessOf([unapproved], { models: 1, routableModels: 0 }, clock(NOW, later(16))).outage).toBe(true);
  });

  it('forgets the run as soon as it ends, so the next one is timed from its own start', () => {
    const over = darknessOf([row()], { models: 1, routableModels: 1 }, clock(NOW, later(16)));
    expect(over.since).toBeNull();
  });

  it('honours a disabled threshold, like the per-endpoint rule', () => {
    const forever = darknessOf(
      [imported()],
      { models: 1, routableModels: 0 },
      {
        thresholds: { afterFailures: 3, afterNoSuccess: 0 },
        since: NOW,
        now: later(48 * 60),
      },
    );
    expect(forever).toMatchObject({ dark: true, outage: false });
  });
});

describe('darkCatalogueAlert', () => {
  const darkness: CatalogueDarkness = { dark: true, since: NOW, outage: true };
  const rebuilt: CatalogueReach = {
    routable: 0,
    models: 2,
    routableModels: 0,
    disabled: 1,
    awaitingKey: 1,
    darkness,
  };
  const facts = (reach: CatalogueReach) =>
    Object.fromEntries(darkCatalogueAlert(darkness, reach, new Date(NOW.getTime() + 20 * 60_000)).facts);

  it('tells the operator the two mutations that end it, when a key is what is missing', () => {
    const alert = darkCatalogueAlert(darkness, rebuilt, new Date(NOW.getTime() + 20 * 60_000));

    expect(alert.title).toContain('serving no models');
    expect(alert.summary).toContain('/v1/models');
    expect(facts(rebuilt)).toMatchObject({
      'Registered external models': '2',
      'Routable right now': '0',
      'Endpoints with no upstream API key': '1',
      'Serving nothing for': '20m',
    });
    expect(alert.action).toContain('rotate');
    expect(alert.action).toContain('enable');
  });

  it('sends an operator to the approval instead when every key is in place', () => {
    const approved = { ...rebuilt, awaitingKey: 0 };
    expect(darkCatalogueAlert(darkness, approved, NOW).action).toContain('approve its evidence digest');
  });

  it('names no endpoint, hostname or key: mail gets forwarded', () => {
    const alert = darkCatalogueAlert(darkness, rebuilt, NOW);
    const text = JSON.stringify(alert);
    expect(text).not.toContain('upstream-a');
    expect(text).not.toContain('sealed');
  });

  it('closes the alert with what is routable again', () => {
    const lit = litCatalogueAlert(NOW, { ...rebuilt, routableModels: 2 }, new Date(NOW.getTime() + 25 * 60_000));
    expect(lit.title).toContain('serving models again');
    expect(Object.fromEntries(lit.facts)).toMatchObject({
      'Routable external models': '2',
      'Served nothing for': '25m',
    });
  });

  it('logs the same facts as the message, so the two cannot disagree', () => {
    const line = darkCatalogueLine(darkness, rebuilt, new Date(NOW.getTime() + 20 * 60_000));
    expect(line).toContain('2 external model(s)');
    expect(line).toContain('20m');
    expect(line).toContain('1 registered endpoint(s) are switched off');
    expect(line).toContain('GET /v1/models answers []');
  });
});
