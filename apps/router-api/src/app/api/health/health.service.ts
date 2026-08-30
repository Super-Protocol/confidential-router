import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { HealthResponseDto } from './health.dto.js';

/** Package version, replaced at build time; `0.0.0` when running from source. */
const VERSION = process.env.CR_API_VERSION ?? '0.0.0';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Liveness plus a real database round-trip.
   *
   * A process that is up but cannot reach PostgreSQL cannot meter a single
   * generation, so it must not stay in the load-balancer rotation — which means
   * the check has to touch the database rather than just return 200.
   */
  async check(): Promise<HealthResponseDto> {
    const database = await this.checkDatabase();
    return {
      status: database.status === 'up' ? 'ok' : 'error',
      version: VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      database,
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
