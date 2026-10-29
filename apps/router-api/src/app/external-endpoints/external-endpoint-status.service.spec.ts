import type { ConfigType } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingOperatorAlerts } from '../../../test/operator-alerts-recorder.js';
import { createTestDataSource, seedExternalEndpoint } from '../../../test/seed.js';
import type { routerConfig } from '../config.js';
import { RouterConfigSchema } from '../config.schema.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { ExternalEndpointEvent } from '../db/entities/external-endpoint-event.entity.js';
import { ExternalCatalogService } from './external-catalog.service.js';
import { ExternalEndpointHealth } from './external-endpoint-health.js';
import { ExternalEndpointStatusService } from './external-endpoint-status.service.js';
import type { SidecarVerdict } from './sidecar-admin.client.js';
import * as adminClient from './sidecar-admin.client.js';

const MEASUREMENT = 'a'.repeat(64);
const DIGEST = 'sha256/BvG0Yy3Ir0QKPtC1TrSPuyZZD1sdKq7Gq_a1Mv1Hs0A';
const OTHER_DIGEST = 'sha256/CwH1Zz4Js1RLQudD2UsTQvzaaE2teLr8Hr_b2Nw2It1B';
const FINGERPRINT = 'sha256/leafleafleafleafleafleafleafleafleafleafle0';

let dataSource: DataSource;
let catalog: ExternalCatalogService;
let health: ExternalEndpointHealth;
let service: ExternalEndpointStatusService;
let alerts: RecordingOperatorAlerts;

function config(): ConfigType<typeof routerConfig> {
  return RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32) },
    externalEndpoints: { adminListen: '127.0.0.1:9465' },
  }) as ConfigType<typeof routerConfig>;
}

/** Answers the next `/verdicts` read with exactly these entries. */
function sidecarReports(...verdicts: SidecarVerdict[]): void {
  vi.spyOn(adminClient, 'fetchSidecarVerdicts').mockResolvedValue(verdicts);
}

function verified(name: string, overrides: Partial<SidecarVerdict['report']> = {}): SidecarVerdict {
  return {
    endpoint: name,
    health: 'confidential',
    admitted: true,
    report: {
      checkedAt: '2026-10-06T11:59:58.000Z',
      verified: true,
      admitted: true,
      attestedRoot: { measurement: MEASUREMENT, measurementSource: 'operator-pinned' },
      certFingerprint: FINGERPRINT,
      evidenceDigest: DIGEST,
      ...overrides,
    },
  };
}

function refused(name: string): SidecarVerdict {
  return {
    endpoint: name,
    health: 'broken',
    admitted: false,
    reason: 'policy: the measurement is not in the trusted list',
    report: { checkedAt: '2026-10-06T11:59:58.000Z', verified: true, admitted: false, stage: 'policy' },
  };
}

beforeEach(async () => {
  dataSource = await createTestDataSource();
  catalog = new ExternalCatalogService(dataSource);
  health = new ExternalEndpointHealth();
  alerts = new RecordingOperatorAlerts();
  service = new ExternalEndpointStatusService(config(), dataSource, catalog, health, alerts.asService());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dataSource.destroy();
});

async function rowOf(id: string): Promise<ExternalEndpoint> {
  return dataSource.getRepository(ExternalEndpoint).findOneByOrFail({ id });
}

async function eventsOf(id: string): Promise<ExternalEndpointEvent[]> {
  return dataSource
    .getRepository(ExternalEndpointEvent)
    .find({ where: { externalEndpointId: id }, order: { kind: 'ASC' } });
}

describe('resetToPending', () => {
  it('drops every verdict column, so a restart cannot inherit trust', async () => {
    // ADR-008 §8: the sidecar starts with no verdict and attests from nothing, so
    // a row that survived saying `verified` would be a trust decision nobody made
    // in this process.
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await dataSource.getRepository(ExternalEndpoint).update(
      { id: endpoint.id },
      {
        measurementSeen: MEASUREMENT,
        measurementSource: 'registry',
        evidenceDigestSeen: DIGEST,
        pinnedCertFingerprint: FINGERPRINT,
        lastCheckedAt: new Date(),
        lastSuccessAt: new Date(),
        lastFailureAt: new Date(),
        consecutiveFailures: 7,
      },
    );
    const boot = new Date('2026-10-24T12:00:00.000Z');

    await expect(service.resetToPending(boot)).resolves.toBe(1);

    expect(await rowOf(endpoint.id)).toMatchObject({
      status: 'pending',
      measurementSeen: null,
      measurementSource: null,
      measurementInRegistry: null,
      evidenceDigestSeen: null,
      pinnedCertFingerprint: null,
      lastCheckedAt: null,
      // The failure run is a verdict projection too (SUP-517), so it goes with
      // the rest — and the clock restarts at this boot, because as of now no
      // endpoint is known to serve.
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      notServingSince: boot,
    });
  });

  it('takes the endpoint out of the routable catalogue', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });
    await catalog.refresh();
    expect(catalog.list()).toHaveLength(1);

    await service.resetToPending();

    expect(catalog.list()).toEqual([]);
    expect(catalog.find(endpoint.modelId)).toBeUndefined();
  });

  it('writes no event, because nothing happened to the endpoint', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'verified' });

    await service.resetToPending();

    expect(await eventsOf(endpoint.id)).toEqual([]);
  });

  it('clears a pending endpoint that was checked — awaiting approval is a verdict too (SUP-252)', async () => {
    // `digest-not-pinned` is `pending` with both factors on the row and a leaf the
    // evidence poller binds to. From a previous process, none of that is a live
    // observation; the pin itself is trust and stays.
    const endpoint = await seedExternalEndpoint(dataSource, { status: 'pending', pinnedEvidenceDigest: DIGEST });
    await dataSource.getRepository(ExternalEndpoint).update(
      { id: endpoint.id },
      {
        lastStage: 'digest-not-pinned',
        measurementSeen: MEASUREMENT,
        evidenceDigestSeen: DIGEST,
        observedCertFingerprint: FINGERPRINT,
        lastCheckedAt: new Date(),
      },
    );
    const untouched = await seedExternalEndpoint(dataSource, { status: 'pending' });

    // Both rows are written, not only the one holding a stale verdict: as of this
    // boot neither is known to serve, and that instant is what the outage
    // thresholds are measured from (SUP-517).
    await expect(service.resetToPending()).resolves.toBe(2);

    expect(await rowOf(endpoint.id)).toMatchObject({
      status: 'pending',
      lastStage: null,
      measurementSeen: null,
      evidenceDigestSeen: null,
      observedCertFingerprint: null,
      lastCheckedAt: null,
      pinnedEvidenceDigest: DIGEST,
    });
    expect((await rowOf(untouched.id)).status).toBe('pending');
  });

  it('leaves a disabled endpoint alone — that value is the operator’s, not a verdict', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { enabled: false, status: 'disabled' });

    await service.resetToPending();

    expect((await rowOf(endpoint.id)).status).toBe('disabled');
  });
});

describe('sync', () => {
  /**
   * The instant these passes run at.
   *
   * `verified()` and `refused()` carry a fixed `checkedAt`, and a verdict is only
   * current while its own check is inside `reattestInterval * 3` (SUP-583). Left
   * to the wall clock these specs would be asserting on a verdict formed
   * whenever the fixture was written, which is a different thing every day and
   * eventually an expired one.
   */
  const NOW = new Date('2026-10-06T12:00:00.000Z');

  it('projects an admission and makes the model routable', async () => {
    const endpoint = await seedExternalEndpoint(dataSource);
    await catalog.refresh();
    expect(catalog.list()).toEqual([]);
    sidecarReports(verified(endpoint.name));

    await expect(service.sync(NOW)).resolves.toEqual({ seen: 1, flipped: 1, events: 1, outages: 0, expired: 0 });

    expect(await rowOf(endpoint.id)).toMatchObject({
      status: 'verified',
      measurementSeen: MEASUREMENT,
      evidenceDigestSeen: DIGEST,
      pinnedCertFingerprint: FINGERPRINT,
    });
    expect(catalog.list().map((model) => model.id)).toEqual([endpoint.modelId]);
  });

  it('drops the model the moment a verdict turns negative', async () => {
    // Decision 5, as seen from router-api's side: the sidecar refuses at the
    // egress, and admission stops offering the model in the same pass.
    const endpoint = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(endpoint.name));
    await service.sync(NOW);
    expect(catalog.list()).toHaveLength(1);

    sidecarReports(refused(endpoint.name));
    await expect(service.sync(NOW)).resolves.toMatchObject({ flipped: 1 });

    expect((await rowOf(endpoint.id)).status).toBe('denied');
    expect(catalog.list()).toEqual([]);
  });

  it('writes one event per transition and none per repetition', async () => {
    const endpoint = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(endpoint.name));
    await service.sync(NOW);

    await expect(service.sync(NOW)).resolves.toEqual({ seen: 1, flipped: 0, events: 0, outages: 0, expired: 0 });
    expect((await eventsOf(endpoint.id)).map((event) => event.kind)).toEqual(['verified']);
  });

  it('does not touch the row when the sidecar repeats the verdict it already had', async () => {
    // At a five-second poll and a ten-minute re-attestation, most passes carry the
    // verdict the row already holds — `checkedAt` included. A write per pass would
    // be pointless load and would keep `updatedAt` moving on an unchanged row.
    const endpoint = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(endpoint.name));
    await service.sync(NOW);
    const after = await rowOf(endpoint.id);

    await expect(service.sync(NOW)).resolves.toEqual({ seen: 1, flipped: 0, events: 0, outages: 0, expired: 0 });

    expect((await rowOf(endpoint.id)).updatedAt).toEqual(after.updatedAt);
  });

  it('records a digest change on a still-verified endpoint', async () => {
    const endpoint = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(endpoint.name));
    await service.sync(NOW);

    sidecarReports(verified(endpoint.name, { evidenceDigest: OTHER_DIGEST }));
    await expect(service.sync(NOW)).resolves.toEqual({ seen: 1, flipped: 0, events: 1, outages: 0, expired: 0 });

    const events = await eventsOf(endpoint.id);
    expect(events.map((event) => event.kind).sort()).toEqual(['digest_changed', 'verified']);
    expect(events.find((event) => event.kind === 'digest_changed')?.evidenceDigest).toBe(OTHER_DIGEST);
    expect((await rowOf(endpoint.id)).evidenceDigestSeen).toBe(OTHER_DIGEST);
  });

  it('leaves an endpoint the sidecar did not mention as it was', async () => {
    // Usually a render the sidecar has not picked up yet. Overwriting a live
    // verdict because one poll raced a reload would flap the catalogue.
    const known = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(known.name));
    await service.sync(NOW);

    sidecarReports();
    await expect(service.sync(NOW)).resolves.toEqual({ seen: 0, flipped: 0, events: 0, outages: 0, expired: 0 });

    expect((await rowOf(known.id)).status).toBe('verified');
    expect(catalog.list()).toHaveLength(1);
  });

  it('ignores a verdict about an endpoint this deployment does not have', async () => {
    await seedExternalEndpoint(dataSource);
    sidecarReports(verified('some-other-name'));

    await expect(service.sync(NOW)).resolves.toEqual({ seen: 0, flipped: 0, events: 0, outages: 0, expired: 0 });
  });

  it('does not project onto a disabled endpoint', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, { enabled: false, status: 'disabled' });
    sidecarReports(verified(endpoint.name));

    await expect(service.sync(NOW)).resolves.toEqual({ seen: 0, flipped: 0, events: 0, outages: 0, expired: 0 });
    expect((await rowOf(endpoint.id)).status).toBe('disabled');
  });

  it('projects several endpoints in one pass', async () => {
    const first = await seedExternalEndpoint(dataSource);
    const second = await seedExternalEndpoint(dataSource);
    sidecarReports(verified(first.name), refused(second.name));

    await expect(service.sync(NOW)).resolves.toEqual({ seen: 2, flipped: 2, events: 2, outages: 0, expired: 0 });

    expect((await rowOf(first.id)).status).toBe('verified');
    expect((await rowOf(second.id)).status).toBe('denied');
    expect(catalog.list().map((model) => model.id)).toEqual([first.modelId]);
  });

  it('lets a transport failure out, so the poller can report it once', async () => {
    vi.spyOn(adminClient, 'fetchSidecarVerdicts').mockRejectedValue(
      new adminClient.SidecarUnavailableError('/verdicts', 'ECONNREFUSED'),
    );

    await expect(service.sync(NOW)).rejects.toThrow(adminClient.SidecarUnavailableError);
  });
});

describe('recordEvent', () => {
  it('appends an event the sidecar has no opinion about', async () => {
    const endpoint = await seedExternalEndpoint(dataSource);

    await service.recordEvent(endpoint.id, 'registered');

    expect((await eventsOf(endpoint.id)).map((event) => event.kind)).toEqual(['registered']);
  });
});

/**
 * The half the router was missing (SUP-517).
 *
 * A production upstream lost the gateway route for its published hostname and
 * every one of these pieces was already correct — the verdict flipped to
 * `denied`, the model left `/v1/models`, every request got a 503 naming the
 * stage. It ran for 30 hours and nobody was told. What these tests pin down is
 * the one new behaviour: a *run* of those denials becomes an alert, exactly once,
 * and says so where an operator looks.
 */
describe('the sustained-failure alert', () => {
  /** A `fetch` failure — the shape the real outage took: the upstream never answered. */
  function unreachable(name: string, checkedAt: string): SidecarVerdict {
    return {
      endpoint: name,
      health: 'broken',
      admitted: false,
      reason: 'fetch: EOF',
      report: {
        checkedAt,
        verified: false,
        admitted: false,
        stage: 'fetch',
        reason: 'fetch: EOF',
        // The sidecar's own answer: the read failed, so nothing arrived (SUP-422).
        unreachable: true,
      },
    };
  }

  /** Collects what the service logs at `level`. */
  function capture(level: 'log' | 'error'): string[] {
    const lines: string[] = [];
    const logger = (service as unknown as { logger: { [key: string]: unknown } }).logger;
    vi.spyOn(logger as never, level).mockImplementation(((message: unknown) => {
      lines.push(String(message));
    }) as never);
    return lines;
  }

  /** An approved, enabled upstream: one this router is entitled to expect to be serving. */
  async function pinnedEndpoint() {
    return seedExternalEndpoint(dataSource, { pinnedEvidenceDigest: DIGEST });
  }

  /** One pass per re-attestation, each with its own `checkedAt`. */
  async function failFor(name: string, checks: number, from = Date.parse('2026-10-23T06:11:00.000Z')) {
    let last = { seen: 0, flipped: 0, events: 0, outages: 0 };
    for (let nth = 0; nth < checks; nth += 1) {
      const at = new Date(from + nth * 10 * 60_000);
      sidecarReports(unreachable(name, at.toISOString()));
      last = await service.sync(at);
    }
    return last;
  }

  it('says nothing about a single failed check', async () => {
    const endpoint = await pinnedEndpoint();
    const errors = capture('error');

    await failFor(endpoint.name, 1);

    expect(errors).toEqual([]);
    expect((await eventsOf(endpoint.id)).map((event) => event.kind)).toEqual(['denied']);
    expect(health.status()).toMatchObject({ status: 'degraded', failing: 1, unreachable: 1 });
  });

  it('pages once the run crosses the threshold, and only once', async () => {
    const endpoint = await pinnedEndpoint();
    const errors = capture('error');

    await failFor(endpoint.name, 3);
    // Two more re-attestations of the same outage. A line repeated every pass is
    // a line a log alert is configured to ignore.
    await failFor(endpoint.name, 5);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`"${endpoint.name}"`);
    expect(errors[0]).toContain('the upstream did not answer');
    expect(errors[0]).toContain('fetch: EOF');
    expect((await eventsOf(endpoint.id)).filter((event) => event.kind === 'outage')).toHaveLength(1);
  });

  it('sends the outage out of the process, once per run, where a human will read it', async () => {
    const endpoint = await pinnedEndpoint();
    capture('error');

    await failFor(endpoint.name, 3);
    await failFor(endpoint.name, 5);

    // The half SUP-517 left out: a log line is an alert only where something
    // watches the log, and nothing watches this one (SUP-535).
    expect(alerts.raised).toHaveLength(1);
    const alert = alerts.one(endpoint.name);
    expect(RecordingOperatorAlerts.factsOf(alert)).toMatchObject({
      Endpoint: endpoint.name,
      'Failed checks in a row': '3',
      Upstream: 'did not answer at all',
    });
  });

  it('sends the recovery past the alert interval, because the operator was woken', async () => {
    const endpoint = await pinnedEndpoint();
    capture('error');
    await failFor(endpoint.name, 3);
    capture('log');

    const recoveredAt = new Date('2026-10-23T07:11:00.000Z');
    sidecarReports(verified(endpoint.name, { checkedAt: recoveredAt.toISOString() }));
    await service.sync(recoveredAt);
    await service.sync(recoveredAt);

    const recoveries = alerts.raised.filter((entry) => entry.alert.title.includes('serving again'));
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].urgent).toBe(true);
  });

  it('records the outage on the endpoint’s own timeline, with the stage that caused it', async () => {
    const endpoint = await pinnedEndpoint();
    capture('error');

    await failFor(endpoint.name, 3);

    const outage = (await eventsOf(endpoint.id)).find((event) => event.kind === 'outage');
    expect(outage).toMatchObject({ stage: 'fetch' });
    expect(outage?.reason).toContain('failed check(s)');
    expect(await rowOf(endpoint.id)).toMatchObject({
      consecutiveFailures: 3,
      notServingSince: new Date('2026-10-23T06:11:00.000Z'),
    });
  });

  it('reports the outage on /health as counts, naming no upstream', async () => {
    const endpoint = await pinnedEndpoint();
    capture('error');

    await failFor(endpoint.name, 3);

    const summary = health.status();
    expect(summary).toMatchObject({ status: 'outage', registered: 1, serving: 0, failing: 1, unreachable: 1 });
    expect(summary.since).toBe('2026-10-23T06:11:00.000Z');
    expect(JSON.stringify(summary)).not.toContain(endpoint.name);
  });

  it('closes the run when the upstream comes back, once', async () => {
    const endpoint = await pinnedEndpoint();
    capture('error');
    await failFor(endpoint.name, 3);
    const logs = capture('log');

    const recoveredAt = new Date('2026-10-23T07:11:00.000Z');
    sidecarReports(verified(endpoint.name, { checkedAt: recoveredAt.toISOString() }));
    await service.sync(recoveredAt);
    // A second admitting pass must not announce a recovery that already happened.
    await service.sync(recoveredAt);

    expect(logs.filter((line) => line.includes('is serving again'))).toHaveLength(1);
    expect((await eventsOf(endpoint.id)).filter((event) => event.kind === 'recovered')).toHaveLength(1);
    expect(health.status()).toMatchObject({ status: 'ok', serving: 1, failing: 0 });
    expect(await rowOf(endpoint.id)).toMatchObject({ consecutiveFailures: 0, notServingSince: null });
  });

  it('does not page for an upstream whose deployment nobody has approved yet', async () => {
    // `pinnedEvidenceDigest: null` — a registration half-finished, not an upstream
    // that went dark. The two-factor upgrade left every existing endpoint in this
    // state at once, and a page for each would have been the wrong lesson.
    const endpoint = await seedExternalEndpoint(dataSource);
    const errors = capture('error');

    await failFor(endpoint.name, 6);

    expect(errors).toEqual([]);
    expect((await eventsOf(endpoint.id)).some((event) => event.kind === 'outage')).toBe(false);
    // Still visible: not serving is not the same as not worth reporting.
    expect(health.status()).toMatchObject({ status: 'degraded', failing: 1 });
  });

  it('does not page for an upstream an operator switched off', async () => {
    const endpoint = await seedExternalEndpoint(dataSource, {
      enabled: false,
      status: 'disabled',
      pinnedEvidenceDigest: DIGEST,
    });
    const errors = capture('error');

    await failFor(endpoint.name, 6);

    expect(errors).toEqual([]);
    expect(health.status()).toMatchObject({ status: 'none', registered: 0 });
  });

  it('pages on elapsed time when the sidecar reports no verdict for a registered endpoint', async () => {
    // The sidecar answers, with nothing to say about this endpoint — a render it
    // has not picked up, or an endpoint it has not started. No verdict, no
    // counter, and every model refused: the failure a count cannot see.
    // `resetToPending` starts the clock and only the duration threshold notices.
    const endpoint = await pinnedEndpoint();
    const boot = new Date('2026-10-23T06:11:00.000Z');
    await service.resetToPending(boot);
    const errors = capture('error');

    sidecarReports();
    await service.sync(new Date(boot.getTime() + 16 * 60_000));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('16m');
    expect(health.status()).toMatchObject({ status: 'outage', pending: 1, failing: 0 });
    expect((await eventsOf(endpoint.id)).map((event) => event.kind)).toEqual(['outage']);
  });

  it('pages when the sidecar itself cannot be read — the case with no verdict to notice it by', async () => {
    // One pod, one sidecar, both in the same container group: a sidecar that
    // wedges or dies takes every external model down and nothing arrives to
    // project. `sync` throws before it ever reaches the alert, so the alert has
    // to live on the rows-only pass too — otherwise `/health` reads `outage`
    // while the log says nothing, which is the disagreement between readers this
    // module refuses.
    const endpoint = await pinnedEndpoint();
    const boot = new Date('2026-10-23T06:11:00.000Z');
    await service.resetToPending(boot);
    const errors = capture('error');

    vi.spyOn(adminClient, 'fetchSidecarVerdicts').mockRejectedValue(
      new adminClient.SidecarUnavailableError('/verdicts', 'ECONNREFUSED'),
    );
    const later = new Date(boot.getTime() + 16 * 60_000);
    await expect(service.sync(later)).rejects.toThrow(adminClient.SidecarUnavailableError);
    await service.refreshFromRows(later);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('16m');
    expect((await eventsOf(endpoint.id)).map((event) => event.kind)).toEqual(['outage']);
    const summary = health.status();
    expect(summary).toMatchObject({ status: 'outage', registered: 1, serving: 0 });
    // Never read, so never claimed: the absent timestamp is what says the counts
    // beside it are not news.
    expect(summary.verdictsReadAt).toBeUndefined();
  });

  it('declares a run once however the pass that noticed it got there', async () => {
    // Both call sites share the latch, so a sidecar that flaps between answering
    // and not must not page twice for one run.
    const endpoint = await pinnedEndpoint();
    const boot = new Date('2026-10-23T06:11:00.000Z');
    await service.resetToPending(boot);
    const errors = capture('error');
    const later = new Date(boot.getTime() + 16 * 60_000);

    await service.refreshFromRows(later);
    sidecarReports();
    await service.sync(new Date(later.getTime() + 2_000));
    await service.refreshFromRows(new Date(later.getTime() + 4_000));

    expect(errors).toHaveLength(1);
    expect((await eventsOf(endpoint.id)).filter((event) => event.kind === 'outage')).toHaveLength(1);
  });

  it('counts only declarations as outages, not the recoveries that close them', async () => {
    const endpoint = await pinnedEndpoint();
    capture('error');
    capture('log');
    await failFor(endpoint.name, 3);

    const recoveredAt = new Date('2026-10-23T07:11:00.000Z');
    sidecarReports(verified(endpoint.name, { checkedAt: recoveredAt.toISOString() }));
    const report = await service.sync(recoveredAt);

    // `outages` is what the poller renders as "outage alert(s)"; a recovery is an
    // event, and it is counted as one.
    expect(report.outages).toBe(0);
    expect(report.events).toBeGreaterThanOrEqual(2);
  });
});

describe('a verdict the sidecar stops confirming (SUP-583)', () => {
  /** Collects what the service logs at `level`. */
  function capture(level: 'log' | 'warn' | 'error'): string[] {
    const lines: string[] = [];
    const logger = (service as unknown as { logger: { [key: string]: unknown } }).logger;
    vi.spyOn(logger as never, level).mockImplementation(((message: unknown) => {
      lines.push(String(message));
    }) as never);
    return lines;
  }

  /** An admitted endpoint, projected from a real read at `at`. */
  async function admitted(at: Date) {
    const endpoint = await seedExternalEndpoint(dataSource, { pinnedEvidenceDigest: DIGEST, withModel: true });
    sidecarReports(verified(endpoint.name, { checkedAt: at.toISOString() }));
    await service.sync(at);
    expect((await rowOf(endpoint.id)).status).toBe('verified');
    expect(catalog.list()).toHaveLength(1);
    return endpoint;
  }

  const READ_AT = new Date('2026-10-24T17:12:37.000Z');
  /** `statusPollInterval` is 5 s, so the grace is 12 polls — a minute. */
  const AFTER_GRACE = new Date(READ_AT.getTime() + 61_000);

  it('keeps the verdict while the sidecar is merely slow to re-attest', async () => {
    // `reattestInterval` is ten minutes, so a verdict whose `checkedAt` is nine
    // minutes old is the design working. What expires a verdict is this router
    // no longer being handed it — never the sidecar's own timestamp.
    const endpoint = await admitted(READ_AT);
    const later = new Date(READ_AT.getTime() + 9 * 60_000);

    sidecarReports(verified(endpoint.name, { checkedAt: READ_AT.toISOString() }));
    await expect(service.sync(later)).resolves.toMatchObject({ expired: 0 });

    expect((await rowOf(endpoint.id)).status).toBe('verified');
    expect(catalog.list()).toHaveLength(1);
  });

  it('keeps the verdict through a poll or two that could not read the sidecar', async () => {
    // A pass that fails is ordinary — a reload, a restarting sidecar. Dropping the
    // model on the first one would make the catalogue flap on nothing.
    const endpoint = await admitted(READ_AT);

    await service.refreshFromRows(new Date(READ_AT.getTime() + 10_000));

    expect((await rowOf(endpoint.id)).status).toBe('verified');
    expect(catalog.list()).toHaveLength(1);
  });

  it('lets the verdict go once the sidecar has stopped confirming it, and drops the model', async () => {
    // The defect this exists for: production answered `models { available: true }`
    // for an upstream whose verdict nothing had re-read, because the boot reset was
    // the only thing that ever cleared one. ADR-008 §8 says a stored status is
    // never trust; this is what makes that true while the process runs.
    const endpoint = await admitted(READ_AT);
    const warnings = capture('warn');

    await service.refreshFromRows(AFTER_GRACE);

    expect(await rowOf(endpoint.id)).toMatchObject({
      status: 'pending',
      evidenceDigestSeen: null,
      pinnedCertFingerprint: null,
      // Nothing was checked, so nothing is claimed about the upstream.
      lastCheckedAt: null,
      upstreamUnreachable: null,
      consecutiveFailures: 0,
      // The clock the outage threshold runs from starts here.
      notServingSince: AFTER_GRACE,
    });
    // When it last served is history, and stays true.
    expect((await rowOf(endpoint.id)).lastSuccessAt).toEqual(READ_AT);
    expect(catalog.list()).toEqual([]);
    expect(catalog.listCatalogue().map((entry) => entry.available)).toEqual([false]);
    expect(catalog.findUnadmitted(endpoint.modelId)).toMatchObject({ status: 'pending' });
    expect(warnings.some((line) => line.includes('has lost its verdict'))).toBe(true);
  });

  it('names the lapse on the endpoint’s own timeline, with the digest that lapsed', async () => {
    const endpoint = await admitted(READ_AT);
    capture('warn');

    await service.refreshFromRows(AFTER_GRACE);

    const expiry = (await eventsOf(endpoint.id)).find((event) => event.kind === 'verdict_expired');
    expect(expiry).toBeDefined();
    expect(expiry?.evidenceDigest).toBe(DIGEST);
    expect(expiry?.reason).toContain('has not confirmed it since');
    // Not a denial: nothing was judged. An operator reading this should look at
    // the sidecar, not at the upstream's cloud.
    expect(expiry?.stage).toBeNull();
  });

  it('expires it once, not once per pass', async () => {
    const endpoint = await admitted(READ_AT);
    capture('warn');

    await service.refreshFromRows(AFTER_GRACE);
    await service.refreshFromRows(new Date(AFTER_GRACE.getTime() + 5_000));
    await service.refreshFromRows(new Date(AFTER_GRACE.getTime() + 10_000));

    expect((await eventsOf(endpoint.id)).filter((event) => event.kind === 'verdict_expired')).toHaveLength(1);
  });

  it('expires an endpoint the sidecar answers about and stops mentioning', async () => {
    // The other shape of the same silence: `/verdicts` is readable and simply has
    // no entry for this endpoint. One rule for both, or the catalogue keeps a
    // model alive through whichever shape it happened to meet.
    const endpoint = await admitted(READ_AT);
    capture('warn');

    sidecarReports();
    await expect(service.sync(AFTER_GRACE)).resolves.toMatchObject({ seen: 0, expired: 1 });

    expect((await rowOf(endpoint.id)).status).toBe('pending');
    expect(catalog.list()).toEqual([]);
  });

  it('alerts by the ordinary outage path once the run it starts gets long enough', async () => {
    // The expiry is silent on its own — it starts a run. From there the upstream
    // that stopped being re-verified pages exactly like one that stopped
    // answering, which is the whole point of writing `notServingSince`.
    const endpoint = await admitted(READ_AT);
    capture('warn');
    const errors = capture('error');

    await service.refreshFromRows(AFTER_GRACE);
    expect(errors).toEqual([]);

    await service.refreshFromRows(new Date(AFTER_GRACE.getTime() + 16 * 60_000));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`"${endpoint.name}"`);
    expect((await eventsOf(endpoint.id)).map((event) => event.kind)).toContain('outage');
    expect(alerts.one('has stopped serving')).toBeDefined();
  });

  it('keeps the verdict while the sidecar keeps re-attesting it', async () => {
    // `reattestInterval` is ten minutes and the window is three of them, so a
    // verdict re-formed on schedule — even a cycle late — is current.
    const endpoint = await admitted(READ_AT);
    const later = new Date(READ_AT.getTime() + 20 * 60_000);

    sidecarReports(verified(endpoint.name, { checkedAt: new Date(later.getTime() - 60_000).toISOString() }));
    await expect(service.sync(later)).resolves.toMatchObject({ expired: 0 });

    expect((await rowOf(endpoint.id)).status).toBe('verified');
    expect(catalog.list()).toHaveLength(1);
  });

  it('lets the verdict go when the sidecar answers but has stopped re-attesting', async () => {
    // The other way the present tense stops being true, and it looks nothing
    // like the first: every poll succeeds, `/verdicts` is readable, and the
    // `checkedAt` inside it has not moved. Read recency cannot see this one — the
    // reads are fine — so without its own bound the row would stay `verified` for
    // ever on a verdict nothing re-formed.
    const endpoint = await admitted(READ_AT);
    const warnings = capture('warn');
    const later = new Date(READ_AT.getTime() + 31 * 60_000);

    sidecarReports(verified(endpoint.name, { checkedAt: READ_AT.toISOString() }));
    await expect(service.sync(later)).resolves.toMatchObject({ seen: 1, expired: 1 });

    expect((await rowOf(endpoint.id)).status).toBe('pending');
    expect(catalog.list()).toEqual([]);
    // The timeline has to say which of the two it was: a wedged admin API and a
    // wedged re-attestation loop are found in different places.
    const expiry = (await eventsOf(endpoint.id)).find((event) => event.kind === 'verdict_expired');
    expect(expiry?.reason).toContain('is answering, but the verdict it keeps repeating');
    expect(warnings.some((line) => line.includes('has not been re-attested since'))).toBe(true);
  });

  it('withdraws the stale verdict once over many passes, and the outage it starts does fire', async () => {
    // The flap this shape invites, and why the bound lives in the projection.
    //
    // A pass that admitted the frozen verdict and *then* expired the row would
    // write a `verified` and a `verdict_expired` every five seconds — ~34k
    // timeline rows a day — and, worse, each `verified` clears `notServingSince`
    // while each expiry resets it to `now`, so the run never ages past one poll
    // and the outage alert this is supposed to raise never fires. The silent half
    // of the defect would be back for the harder wedge.
    //
    // Refusing to admit it in the first place makes the row stable: one
    // withdrawal, then nothing, and `notServingSince` left where the last real
    // check was so the ordinary threshold can run out.
    const endpoint = await admitted(READ_AT);
    const warnings = capture('warn');
    const errors = capture('error');

    // Forty passes of a sidecar answering happily with the verdict it formed at
    // READ_AT — five seconds apart, starting past the attest window.
    for (let nth = 0; nth < 40; nth += 1) {
      sidecarReports(verified(endpoint.name, { checkedAt: READ_AT.toISOString() }));
      await service.sync(new Date(READ_AT.getTime() + 31 * 60_000 + nth * 5_000));
    }

    const kinds = (await eventsOf(endpoint.id)).map((event) => event.kind);
    expect(kinds.filter((kind) => kind === 'verdict_expired')).toHaveLength(1);
    // The `verified` from `admitted()` and not one more: no pass re-admitted it.
    expect(kinds.filter((kind) => kind === 'verified')).toHaveLength(1);
    expect(warnings.filter((line) => line.includes('has lost its verdict'))).toHaveLength(1);

    // And the run reaches the threshold instead of being restarted every pass.
    expect(kinds).toContain('outage');
    expect(errors).toHaveLength(1);
    expect(alerts.one('has stopped serving')).toBeDefined();
    expect((await rowOf(endpoint.id)).status).toBe('pending');
    expect(catalog.list()).toEqual([]);
  });

  it('counts the withdrawal as an expiry in the pass that made it, and not again', async () => {
    const endpoint = await admitted(READ_AT);
    capture('warn');
    capture('error');
    const stale = verified(endpoint.name, { checkedAt: READ_AT.toISOString() });

    sidecarReports(stale);
    await expect(service.sync(new Date(READ_AT.getTime() + 31 * 60_000))).resolves.toMatchObject({ expired: 1 });

    sidecarReports(stale);
    await expect(service.sync(new Date(READ_AT.getTime() + 31 * 60_000 + 5_000))).resolves.toMatchObject({
      expired: 0,
      flipped: 0,
      events: 0,
    });
  });

  it('leaves the row untouched while it repeats the withdrawn verdict', async () => {
    // `lastReason` names `checkedAt` and never `now`, so the same frozen verdict
    // produces the same row — a write per poll would keep `updatedAt` moving on
    // a row nothing happened to.
    const endpoint = await admitted(READ_AT);
    capture('warn');
    capture('error');
    const stale = verified(endpoint.name, { checkedAt: READ_AT.toISOString() });

    sidecarReports(stale);
    await service.sync(new Date(READ_AT.getTime() + 31 * 60_000));
    const after = await rowOf(endpoint.id);

    sidecarReports(stale);
    await service.sync(new Date(READ_AT.getTime() + 31 * 60_000 + 5_000));

    expect((await rowOf(endpoint.id)).updatedAt).toEqual(after.updatedAt);
    // Started at the last real check rather than at the pass that noticed, which
    // is what lets the threshold run out at all.
    expect(after.notServingSince).toEqual(READ_AT);
  });

  it('comes back as soon as the sidecar confirms a verdict again', async () => {
    const endpoint = await admitted(READ_AT);
    capture('warn');
    await service.refreshFromRows(AFTER_GRACE);
    expect(catalog.list()).toEqual([]);

    const back = new Date(AFTER_GRACE.getTime() + 5_000);
    sidecarReports(verified(endpoint.name, { checkedAt: back.toISOString() }));
    await expect(service.sync(back)).resolves.toMatchObject({ flipped: 1, expired: 0 });

    expect((await rowOf(endpoint.id)).status).toBe('verified');
    expect(catalog.list()).toHaveLength(1);
  });
});
