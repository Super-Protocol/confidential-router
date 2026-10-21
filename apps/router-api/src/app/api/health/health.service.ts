import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { routerConfig, serviceVersion } from '../../config.js';
import { MailService } from '../../mail/mail.service.js';
import type { HealthResponseDto } from './health.dto.js';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly mail: MailService,
    @Inject(routerConfig.KEY) private readonly config: ConfigType<typeof routerConfig>,
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
   * `mail.signUpGate` is the one line that keeps the rest of the block from
   * being read wrong on an invite-only deployment, where a `200` from the send
   * route and a healthy `state` are both compatible with nothing having been
   * sent (SUP-462). It is configuration, not an event — the *counts* move per
   * request and so live behind the admin guard, on `mailDelivery`, because a
   * number a stranger can read before and after naming an address tells them
   * by subtraction whether that address was mailed.
   */
  async check(): Promise<HealthResponseDto> {
    const database = await this.checkDatabase();
    return {
      status: database.status === 'up' ? 'ok' : 'error',
      version: serviceVersion(),
      uptimeSeconds: Math.round(process.uptime()),
      database,
      mail: {
        ...this.mail.status(),
        signUpGate: this.config.auth.requireInviteForSignUp ? 'invite_only' : 'open',
      },
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
