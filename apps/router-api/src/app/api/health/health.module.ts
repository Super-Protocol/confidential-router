import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../../analytics/analytics.module.js';
import { MailModule } from '../../mail/mail.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [MailModule, AnalyticsModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
