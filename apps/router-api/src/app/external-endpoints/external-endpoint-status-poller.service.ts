import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { ExternalEndpointStatusService } from './external-endpoint-status.service.js';

/**
 * Drives {@link ExternalEndpointStatusService.sync} on an interval
 * (`externalEndpoints.statusPollInterval`, default 5 s).
 *
 * The same runner shape as `EvidencePollerService`, and the same two reasons for
 * it: a `running` latch so a slow pass cannot overlap itself, and an unreffed
 * timer so a poller is never why a container refuses to exit. A failed poll is a
 * logged warning — a sidecar that is not answering yet is a state, not a crash,
 * and every endpoint is already held at `pending` while it lasts.
 *
 * Unlike the evidence poller this one is **not** replica-safe by construction,
 * and does not need to be: the chart ships `replicaCount: 1`, the sidecar is a
 * container in that pod, and each replica would be polling its own sidecar about
 * its own endpoints anyway (ADR-008 §8).
 */
@Injectable()
export class ExternalEndpointStatusPollerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ExternalEndpointStatusPollerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Suppresses a repeated "the sidecar is not answering" line every few seconds. */
  private lastFailure: string | null = null;

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly status: ExternalEndpointStatusService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Awaited, unlike the first evidence poll: until every endpoint is back at
    // `pending` the catalogue could still be offering a model from the last run's
    // verdict, and that is the one thing ADR-008 §8 forbids. It is a local
    // `UPDATE`, not a remote call.
    await this.status.resetToPending();

    const interval = this.config.externalEndpoints.statusPollInterval;
    if (interval <= 0) {
      this.logger.log('External endpoint status polling is disabled (externalEndpoints.statusPollInterval is 0).');
      return;
    }
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass, exposed so a test — and any future admin trigger — can await it. */
  async pollOnce(now: Date = new Date()): Promise<void> {
    if (this.running) {
      this.logger.debug('Skipping an external endpoint status poll: the previous pass is still running.');
      return;
    }
    this.running = true;
    try {
      const report = await this.status.sync(now);
      this.lastFailure = null;
      if (report.flipped > 0 || report.events > 0) {
        this.logger.debug(
          `External endpoint status: ${report.seen} reported, ${report.flipped} flipped, ${report.events} event(s).`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastFailure) {
        this.logger.warn(`External endpoint status poll failed: ${message}`);
        this.lastFailure = message;
      }
    } finally {
      this.running = false;
    }
  }
}
