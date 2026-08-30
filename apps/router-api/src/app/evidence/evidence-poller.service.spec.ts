import type { ConfigType } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { routerConfig } from '../config.js';
import { RouterConfigSchema } from '../config.schema.js';
import type { Endpoint } from '../db/entities/endpoint.entity.js';
import type { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import type { EvidenceService } from './evidence.service.js';
import { EvidencePollerService } from './evidence-poller.service.js';

function endpoint(name: string): Endpoint {
  return { name, hostname: `${name}.example.test` } as Endpoint;
}

function configWith(pollInterval: string): ConfigType<typeof routerConfig> {
  return RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32) },
    evidence: { pollInterval },
  }) as ConfigType<typeof routerConfig>;
}

/** An `EvidenceService` stub: the poller's job is scheduling and error containment. */
function evidenceStub(overrides: Partial<EvidenceService> = {}): EvidenceService {
  return {
    activeEndpoints: async () => [],
    refresh: async () => ({}) as EvidenceSnapshot,
    logFetchFailure: () => undefined,
    ...overrides,
  } as EvidenceService;
}

describe('pollAll', () => {
  it('refreshes every endpoint the config declares', async () => {
    const refresh = vi.fn(async () => ({}) as EvidenceSnapshot);
    const poller = new EvidencePollerService(
      configWith('5m'),
      evidenceStub({ activeEndpoints: async () => [endpoint('a'), endpoint('b')], refresh }),
    );

    await expect(poller.pollAll()).resolves.toEqual({ polled: 2, stored: 2, failed: 0 });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps polling after one endpoint fails, and reports it', async () => {
    const logFetchFailure = vi.fn();
    const poller = new EvidencePollerService(
      configWith('5m'),
      evidenceStub({
        activeEndpoints: async () => [endpoint('down'), endpoint('up')],
        refresh: async (target: Endpoint) => {
          if (target.name === 'down') throw new Error('ECONNREFUSED');
          return {} as EvidenceSnapshot;
        },
        logFetchFailure,
      }),
    );

    await expect(poller.pollAll()).resolves.toEqual({ polled: 2, stored: 1, failed: 1 });
    expect(logFetchFailure).toHaveBeenCalledOnce();
  });

  it('does not overlap itself when a pass is still running', async () => {
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const poller = new EvidencePollerService(
      configWith('5m'),
      evidenceStub({
        activeEndpoints: async () => [endpoint('slow')],
        refresh: async () => {
          await started;
          return {} as EvidenceSnapshot;
        },
      }),
    );

    const first = poller.pollAll();
    const second = await poller.pollAll();
    release();

    expect(second).toEqual({ polled: 0, stored: 0, failed: 0 });
    await expect(first).resolves.toMatchObject({ polled: 1 });
  });
});

describe('scheduling', () => {
  it('schedules a repeating poll on boot', async () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn(async () => ({}) as EvidenceSnapshot);
      const poller = new EvidencePollerService(
        configWith('5m'),
        evidenceStub({ activeEndpoints: async () => [endpoint('a')], refresh }),
      );

      poller.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      poller.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

      // The immediate poll on boot, plus one per interval; nothing after destroy.
      expect(refresh).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays off when the interval is zero', async () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn(async () => ({}) as EvidenceSnapshot);
      const poller = new EvidencePollerService(
        configWith('0s'),
        evidenceStub({ activeEndpoints: async () => [endpoint('a')], refresh }),
      );

      poller.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
