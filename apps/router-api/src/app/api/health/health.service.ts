import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnalyticsHealth } from '../../analytics/analytics-health.js';
import { serviceVersion } from '../../config.js';
import { MailService } from '../../mail/mail.service.js';
import { EvidenceRetentionHealth } from '../../preferences/evidence-retention-health.js';
import type { HealthResponseDto } from './health.dto.js';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly analytics: AnalyticsHealth,
    private readonly evidenceRetention: EvidenceRetentionHealth,
  ) {}

  /**
   * Liveness plus a real database round-trip.
   *
   * A process that is up but cannot reach PostgreSQL cannot meter a single
   * generation, so it must not stay in the load-balancer rotation — which means
   * the check has to touch the database rather than just return 200.
   *
   * Mail is reported and never decides the status: a deployment whose mail
   * server is down still serves every model, and taking it out of rotation for
   * that would turn a lost welcome mail into an outage. It is here so that mail
   * which is not getting through is visible somewhere other than a log line
   * (SUP-269).
   *
   * Analytics is here for exactly that reason and under exactly that rule
   * (SUP-464): a deployment whose `POSTHOG_PROJECT_KEY` a rebuild forgot still
   * serves every model, so a missing chart must never take it out of rotation —
   * but it must be answerable without reading the boot log.
   *
   * `evidenceRetention` is the third of the same kind (SUP-498). A deployment
   * whose retention sweep is not running serves every model too — it just keeps
   * archived bundles past the period `/privacy` publishes, which is the one
   * failure here that is a disclosure problem rather than an availability one.
   * It was unobservable for a whole preview; now it is a field.
   */
  async check(): Promise<HealthResponseDto> {
    const database = await this.checkDatabase();
    return {
      status: database.status === 'up' ? 'ok' : 'error',
      version: serviceVersion(),
      uptimeSeconds: Math.round(process.uptime()),
      database,
      mail: this.mail.status(),
      analytics: this.analytics.status(),
      evidenceRetention: this.evidenceRetention.status(),
    };
  }

  private async checkDatabase(): Promise<HealthResponseDto['database']> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'up' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Database health check failed: ${message}`);
      return { status: 'down', error: message };
    }
  }
}
