import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { routerConfig } from '../config.js';
import { RouterConfigSchema } from '../config.schema.js';
import type { ExternalEndpointStatusService, SyncReport } from './external-endpoint-status.service.js';
import { ExternalEndpointStatusPollerService } from './external-endpoint-status-poller.service.js';
import { SidecarUnavailableError } from './sidecar-admin.client.js';

const QUIET: SyncReport = { seen: 0, flipped: 0, events: 0 };

/**
 * The services keep their `Logger` private, and what reaches a log line is part
 * of what these tests are about. One cast, named, instead of a bracket access at
 * every call site.
 */
function loggerOf(service: object): Logger {
  return (service as unknown as { logger: Logger }).logger;
}

/** Collects what the service logs at `level`, in order. */
function capture(service: object, level: 'log' | 'warn' | 'error'): string[] {
  const lines: string[] = [];
  // Nest's `Logger` methods take `(message, ...optionalParams)`, so the mock has
  // to as well; only the message is what these tests read.
  vi.spyOn(loggerOf(service), level).mockImplementation((message: unknown, ..._rest: unknown[]): void => {
    lines.push(String(message));
  });
  return lines;
}

function configWith(statusPollInterval: string): ConfigType<typeof routerConfig> {
  return RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32) },
    externalEndpoints: { statusPollInterval },
  }) as ConfigType<typeof routerConfig>;
}

/** A status-service stub: the poller's job is scheduling and error containment. */
function statusStub(overrides: Partial<ExternalEndpointStatusService> = {}): ExternalEndpointStatusService {
  return {
    resetToPending: async () => 0,
    sync: async () => QUIET,
    recordEvent: async () => undefined,
    ...overrides,
  } as ExternalEndpointStatusService;
}

describe('onApplicationBootstrap', () => {
  it('resets every endpoint to pending before the first poll', async () => {
    // Awaited, unlike the evidence poller's first pass: until the reset lands the
    // catalogue could still be offering a model admitted by the *last* run's
    // verdict, which is the one thing ADR-008 §8 forbids.
    const order: string[] = [];
    const poller = new ExternalEndpointStatusPollerService(
      configWith('5s'),
      statusStub({
        resetToPending: async () => {
          order.push('reset');
          return 1;
        },
        sync: async () => {
          order.push('sync');
          return QUIET;
        },
      }),
    );

    await poller.onApplicationBootstrap();
    poller.onModuleDestroy();

    expect(order[0]).toBe('reset');
    expect(order).toContain('sync');
  });

  it('still resets when polling is switched off', async () => {
    const resetToPending = vi.fn(async () => 1);
    const sync = vi.fn(async () => QUIET);
    const poller = new ExternalEndpointStatusPollerService(configWith('0s'), statusStub({ resetToPending, sync }));

    await poller.onApplicationBootstrap();

    expect(resetToPending).toHaveBeenCalledOnce();
    expect(sync).not.toHaveBeenCalled();
  });

  it('does not hold the process open for its timer', async () => {
    const poller = new ExternalEndpointStatusPollerService(configWith('5s'), statusStub());

    await poller.onApplicationBootstrap();
    // `unref` is what stops a poller being the reason a container refuses to
    // exit. `hasRef` is Node's own answer to whether it would.
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
    const sync = vi.fn(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return QUIET;
    });
    const poller = new ExternalEndpointStatusPollerService(configWith('5s'), statusStub({ sync }));

    const first = poller.pollOnce();
    await started;
    await poller.pollOnce();
    await first;

    expect(sync).toHaveBeenCalledOnce();
  });

  it('contains a sidecar that is not answering, and says so once', async () => {
    // A sidecar still starting up is a state, not a crash — every endpoint is
    // already held at `pending` while it lasts — and a warning every five seconds
    // would be the only thing in the log.
    const poller = new ExternalEndpointStatusPollerService(
      configWith('5s'),
      statusStub({
        sync: async () => {
          throw new SidecarUnavailableError('/verdicts', 'ECONNREFUSED');
        },
      }),
    );
    const warnings = capture(poller, 'warn');

    await poller.pollOnce();
    await poller.pollOnce();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ECONNREFUSED');
  });

  it('warns again once the failure changes', async () => {
    let reason = 'ECONNREFUSED';
    const poller = new ExternalEndpointStatusPollerService(
      configWith('5s'),
      statusStub({
        sync: async () => {
          throw new SidecarUnavailableError('/verdicts', reason);
        },
      }),
    );
    const warnings = capture(poller, 'warn');

    await poller.pollOnce();
    reason = 'it answered 500';
    await poller.pollOnce();

    expect(warnings).toHaveLength(2);
  });

  it('forgets a failure once the sidecar answers again', async () => {
    let failing = true;
    const poller = new ExternalEndpointStatusPollerService(
      configWith('5s'),
      statusStub({
        sync: async () => {
          if (failing) {
            throw new SidecarUnavailableError('/verdicts', 'ECONNREFUSED');
          }
          return QUIET;
        },
      }),
    );
    const warnings = capture(poller, 'warn');

    await poller.pollOnce();
    failing = false;
    await poller.pollOnce();
    failing = true;
    await poller.pollOnce();

    expect(warnings).toHaveLength(2);
  });
});
