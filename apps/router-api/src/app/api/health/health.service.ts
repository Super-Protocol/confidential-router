import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OperatorAlertsService } from '../../alerts/operator-alerts.service.js';
import { AnalyticsHealth } from '../../analytics/analytics-health.js';
import { serviceVersion } from '../../config.js';
import { ExternalEndpointHealth } from '../../external-endpoints/external-endpoint-health.js';
import { MailService } from '../../mail/mail.service.js';
import { MailDeliveryService } from '../../mail/mail-delivery.service.js';
import type { HealthResponseDto } from './health.dto.js';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  // biome-ignore lint/complexity/useMaxParams: a Nest DI constructor has no call site to keep readable.
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly deliveries: MailDeliveryService,
    private readonly analytics: AnalyticsHealth,
    private readonly externalEndpoints: ExternalEndpointHealth,
    private readonly alerts: OperatorAlertsService,
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
   * `mail.undeliverable` is the third of the same kind (SUP-551), and the one
   * that is about people rather than about configuration: an address the
   * provider is dropping mail to cannot be sent a sign-in code, and the send
   * succeeds every time. It is counted here because it exists nowhere else in
   * this process — and read on `/admin/health`, which the Ingress publishes,
   * rather than only on this route, which it does not (SUP-479).
   *
   * External upstreams are here under the same rule and for the sharpest version
   * of the reason (SUP-517). A dead upstream is the one subsystem failure that
   * *does* stop completions working, and it still must not decide `status`: the
   * process serves built-in models, the console and every other route perfectly
   * well, and dropping it from the rotation would turn one dark upstream into a
   * dark deployment. It is reported because the alternative is what happened —
   * 503s for 30 hours, found by a human.
   *
   * The alert *channel* is reported for the reason the subsystems above are, one
   * step further on (SUP-535): an outage that was detected and could not be told
   * to anybody is indistinguishable from no outage, and `alerts.state:
   * unconfigured` beside `externalEndpoints.status: outage` is the pair that says
   * so. A count of recipients, never an address.
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
      mail: { ...this.mail.status(), undeliverable: await this.undeliverable(database) },
      analytics: this.analytics.status(),
      externalEndpoints: this.externalEndpoints.status(),
      alerts: this.alerts.status(),
    };
  }

  /**
   * One indexed count, and only while the database answered: a health document
   * that threw because the query it added could not run would turn a reported
   * dependency failure into an unreported one.
   */
  private async undeliverable(
    database: HealthResponseDto['database'],
  ): Promise<{ addresses: number; lastAt?: string }> {
    if (database.status !== 'up') {
      return { addresses: 0 };
    }
    try {
      return await this.deliveries.undeliverable();
    } catch (error) {
      this.logger.error(`Could not count undeliverable addresses: ${error instanceof Error ? error.message : error}.`);
      return { addresses: 0 };
    }
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
