import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { routerConfig } from '../config.js';
import { RouterConfigSchema } from '../config.schema.js';
import type { ExternalEvidenceReport, ExternalEvidenceService } from './external-evidence.service.js';
import { ExternalEvidencePollerService } from './external-evidence-poller.service.js';

const QUIET: ExternalEvidenceReport = { polled: 0, stored: 0, failed: 0 };

function configWith(evidencePollInterval: string): ConfigType<typeof routerConfig> {
  return RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32) },
    externalEndpoints: { evidencePollInterval },
  }) as ConfigType<typeof routerConfig>;
}

/** An evidence-service stub: the poller's job is scheduling and error containment. */
function evidenceStub(overrides: Partial<ExternalEvidenceService> = {}): ExternalEvidenceService {
  return {
    refreshAll: async () => QUIET,
    refresh: async () => undefined,
    summariesFor: async () => new Map(),
    ...overrides,
  } as unknown as ExternalEvidenceService;
}

/** Collects what the service logs at `level`, in order. */
function capture(service: object, level: 'log' | 'warn'): string[] {
  const lines: string[] = [];
  vi.spyOn((service as unknown as { logger: Logger }).logger, level).mockImplementation(
    (message: unknown, ..._rest: unknown[]): void => {
      lines.push(String(message));
    },
  );
  return lines;
}

describe('onApplicationBootstrap', () => {
  it('starts a pass without waiting for it, because nothing depends on it having run', async () => {
    // Unlike the status poller's reset: no model is offered or withheld on the
    // strength of an evidence summary, so boot must not wait on another
    // operator's cluster.
    let started = false;
    const poller = new ExternalEvidencePollerService(
      configWith('1m'),
      evidenceStub({
        refreshAll: async () => {
          started = true;
          return QUIET;
        },
      }),
    );

    poller.onApplicationBootstrap();
    await Promise.resolve();
    poller.onModuleDestroy();

    expect(started).toBe(true);
  });

  it('says so and polls nothing when the summary is switched off', () => {
    const refreshAll = vi.fn(async () => QUIET);
    const poller = new ExternalEvidencePollerService(configWith('0s'), evidenceStub({ refreshAll }));
    const lines = capture(poller, 'log');

    poller.onApplicationBootstrap();

    expect(refreshAll).not.toHaveBeenCalled();
    expect(lines[0]).toContain('evidencePollInterval');
  });

  it('does not hold the process open for its timer', () => {
    const poller = new ExternalEvidencePollerService(configWith('1m'), evidenceStub());

    poller.onApplicationBootstrap();

    const timer = (poller as unknown as { timer: NodeJS.Timeout | null }).timer;
    expect(timer?.hasRef()).toBe(false);
    poller.onModuleDestroy();
  });
});

describe('pollOnce', () => {
  it('does not overlap itself when a pass is still running', async () => {
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshAll = vi.fn(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return QUIET;
    });
    const poller = new ExternalEvidencePollerService(configWith('1m'), evidenceStub({ refreshAll }));

    const first = poller.pollOnce();
    await started;
    await poller.pollOnce();
    await first;

    // A cross-cloud fetch can outlast the interval, and two passes racing would
    // fetch the same publication twice for no gain.
    expect(refreshAll).toHaveBeenCalledOnce();
  });

  it('contains a pass that threw rather than letting it escape a timer', async () => {
    const poller = new ExternalEvidencePollerService(
      configWith('1m'),
      evidenceStub({
        refreshAll: async () => {
          throw new Error('SQLITE_BUSY');
        },
      }),
    );
    const warnings = capture(poller, 'warn');

    await poller.pollOnce();

    expect(warnings[0]).toContain('SQLITE_BUSY');
    // And the latch is released, so the next pass still runs.
    expect((poller as unknown as { running: boolean }).running).toBe(false);
  });
});
