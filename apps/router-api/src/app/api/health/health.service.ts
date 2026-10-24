import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnalyticsHealth } from '../../analytics/analytics-health.js';
import { serviceVersion } from '../../config.js';
import { ExternalEndpointHealth } from '../../external-endpoints/external-endpoint-health.js';
import { MailService } from '../../mail/mail.service.js';
import type { HealthResponseDto } from './health.dto.js';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly analytics: AnalyticsHealth,
    private readonly externalEndpoints: ExternalEndpointHealth,
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
   * External upstreams are here under the same rule and for the sharpest version
   * of the reason (SUP-517). A dead upstream is the one subsystem failure that
   * *does* stop completions working, and it still must not decide `status`: the
   * process serves built-in models, the console and every other route perfectly
   * well, and dropping it from the rotation would turn one dark upstream into a
   * dark deployment. It is reported because the alternative is what happened —
   * 503s for 30 hours, found by a human.
   *
   * Counts only, no endpoint names: `/health` is unauthenticated, and ruling 3 on
   * SUP-221 keeps upstream identity and verdict detail behind a session.
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
      externalEndpoints: this.externalEndpoints.status(),
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
