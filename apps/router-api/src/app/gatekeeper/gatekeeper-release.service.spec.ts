import type { ConfigType } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { routerConfig } from '../config.js';
import { GatekeeperReleaseService } from './gatekeeper-release.service.js';
import * as fetcher from './release-fetcher.js';
import { ReleaseFetchError } from './release-fetcher.js';

const CONFIG = {
  gatekeeper: {
    repo: 'Super-Protocol/confidential-router',
    apiBaseUrl: 'https://api.github.test',
    cacheTtl: 15 * 60 * 1000,
    requestTimeout: 5_000,
  },
} as unknown as ConfigType<typeof routerConfig>;

const RELEASE = {
  version: 'v0.4.1',
  publishedAt: new Date('2026-08-20T10:00:00.000Z'),
  notesUrl: 'https://github.test/notes',
  checksumsUrl: null,
  downloads: [],
};

let service: GatekeeperReleaseService;
let fetchLatest: MockInstance<typeof fetcher.fetchLatestRelease>;

beforeEach(() => {
  service = new GatekeeperReleaseService(CONFIG);
  fetchLatest = vi.spyOn(fetcher, 'fetchLatestRelease').mockResolvedValue(RELEASE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const T0 = new Date('2026-08-31T12:00:00.000Z');
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe('GatekeeperReleaseService', () => {
  it('reads the release once and serves the cached copy inside the window', async () => {
    await service.latest(T0);
    const second = await service.latest(later(14));

    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ version: 'v0.4.1', stale: false, fetchedAt: T0 });
  });

  it('reads again once the copy has aged past the window', async () => {
    await service.latest(T0);
    await service.latest(later(16));

    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('makes one call for callers that arrive together', async () => {
    // The console is opened by everyone at once on a Monday morning, and the
    // GitHub API is rate-limited per source IP.
    await Promise.all([service.latest(T0), service.latest(T0), service.latest(T0)]);

    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known links when a refresh fails, and says they are stale', async () => {
    await service.latest(T0);
    fetchLatest.mockRejectedValueOnce(new ReleaseFetchError('GET returned 503'));

    const served = await service.latest(later(20));

    expect(served).toMatchObject({ version: 'v0.4.1', stale: true, fetchedAt: T0 });
  });

  it('recovers on the next window rather than staying stale', async () => {
    await service.latest(T0);
    fetchLatest.mockRejectedValueOnce(new ReleaseFetchError('GET returned 503'));
    await service.latest(later(20));

    const recovered = await service.latest(later(40));

    expect(recovered).toMatchObject({ stale: false, fetchedAt: later(40) });
  });

  it('answers null when nothing has ever been retrieved', async () => {
    fetchLatest.mockRejectedValue(new ReleaseFetchError('offline'));

    expect(await service.latest(T0)).toBeNull();
  });

  it('retries after a failed first call instead of caching the failure', async () => {
    fetchLatest.mockRejectedValueOnce(new ReleaseFetchError('offline'));
    await service.latest(T0);

    expect(await service.latest(T0)).toMatchObject({ version: 'v0.4.1' });
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });
});
