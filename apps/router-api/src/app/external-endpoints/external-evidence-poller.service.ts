import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { ExternalEvidenceService } from './external-evidence.service.js';

/**
 * Drives {@link ExternalEvidenceService.refreshAll} on an interval
 * (`externalEndpoints.evidencePollInterval`, default 1 minute).
 *
 * Its own runner rather than a leg of the verdict poll, which runs every five
 * seconds: that pass is a local read of a loopback admin API and must stay fast,
 * and putting a cross-cloud HTTPS fetch inside it would make the catalogue's
 * freshness depend on another operator's ingress latency. The evidence summary is
 * display detail (SUP-221 ruling 1); the verdict is not, and the two should not
 * share a deadline.
 *
 * Replica-safe by construction, like the own-endpoint poller: snapshots are
 * idempotent on `(externalEndpointId, evidenceDigest, certFingerprint, issuedAt)`,
 * so N replicas converge on one row per publication instead of racing for a lock.
 */
@Injectable()
export class ExternalEvidencePollerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ExternalEvidencePollerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
    private readonly evidence: ExternalEvidenceService,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.externalEndpoints.evidencePollInterval;
    if (interval <= 0) {
      this.logger.log(
        'External upstream evidence polling is disabled (externalEndpoints.evidencePollInterval is 0); the admin ' +
          'section will render no evidence summary.',
      );
      return;
    }
    // Not awaited: boot must not wait on another operator's cluster. Nothing is
    // offered or withheld on the strength of this pass, so late is harmless and
    // the field is nullable for exactly this reason.
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

  /** One pass, exposed so a test can await it rather than sleep for one. */
  async pollOnce(now: Date = new Date()): Promise<void> {
    if (this.running) {
      this.logger.debug('Skipping an external upstream evidence poll: the previous pass is still running.');
      return;
    }
    this.running = true;
    try {
      const report = await this.evidence.refreshAll(now);
      if (report.polled > 0) {
        this.logger.debug(
          `External upstream evidence: ${report.stored}/${report.polled} summarised, ${report.failed} unavailable.`,
        );
      }
    } catch (error) {
      // A pass that threw is a pass that found the database unavailable; the next
      // one is a minute away and nothing depends on this one having run.
      this.logger.warn(
        `External upstream evidence poll failed: ${error instanceof Error ? error.message : String(error)}.`,
      );
    } finally {
      this.running = false;
    }
  }
}
