import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../../analytics/analytics.module.js';
import { MailModule } from '../../mail/mail.module.js';
import { PreferencesModule } from '../../preferences/preferences.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [MailModule, AnalyticsModule, PreferencesModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
