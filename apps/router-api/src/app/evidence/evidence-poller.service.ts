import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { EvidenceService } from './evidence.service.js';

export interface PollReport {
  polled: number;
  stored: number;
  failed: number;
}

/**
 * Fetches every configured endpoint's published bundle on an interval
 * (`evidence.pollInterval`, default 5 minutes).
 *
 * **Replica-safe without leader election.** Snapshots are idempotent on
 * `(endpointId, evidenceDigest, certFingerprint, issuedAt)` (ADR-002), so N
 * replicas polling the same endpoint converge on one row per publication
 * instead of racing for a lock. The only per-process state is the timer and the
 * `running` latch below, which keeps a slow poll from overlapping itself when an
 * endpoint is timing out.
 *
 * A poll failure is a logged warning, never a thrown error: an endpoint that
 * publishes nothing is a state the console renders (`NOT_PUBLISHED`), and one
 * unreachable host must not stop the others from being polled.
 */
@Injectable()
export class EvidencePollerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EvidencePollerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly evidence: EvidenceService,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.evidence.pollInterval;
    if (interval <= 0) {
      this.logger.log('Evidence polling is disabled (evidence.pollInterval is 0).');
      return;
    }
    // Not awaited: boot must not wait on remote hosts. The first poll runs on
    // the next tick, and the console can always force one through
    // `refreshEvidence`.
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), interval);
    // Node keeps the process alive for a pending timer; a poller must not be
    // the reason a container refuses to exit.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass over every enabled endpoint. Exposed so tests — and any future
   * admin trigger — can await a full pass rather than sleep for one.
   */
  async pollAll(now: Date = new Date()): Promise<PollReport> {
    if (this.running) {
      this.logger.debug('Skipping evidence poll: the previous pass is still running.');
      return { polled: 0, stored: 0, failed: 0 };
    }
    this.running = true;
    const report: PollReport = { polled: 0, stored: 0, failed: 0 };
    try {
      const endpoints = await this.evidence.activeEndpoints();
      for (const endpoint of endpoints) {
        report.polled += 1;
        try {
          await this.evidence.refresh(endpoint, now);
          report.stored += 1;
        } catch (error) {
          report.failed += 1;
          this.evidence.logFetchFailure(endpoint, error);
        }
      }
    } finally {
      this.running = false;
    }
    if (report.polled > 0) {
      this.logger.debug(`Evidence poll: ${report.stored}/${report.polled} endpoint(s) published a bundle.`);
    }
    return report;
  }
}
