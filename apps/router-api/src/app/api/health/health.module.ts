import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../../analytics/analytics.module.js';
import { AuthModule } from '../../auth/index.js';
import { MailModule } from '../../mail/mail.module.js';
import { AdminHealthController } from './admin-health.controller.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/**
 * One health document, two routes: `/health` for the kubelet, unauthenticated
 * and off the chart's Ingress, and `/admin/health` for the operator, behind the
 * session guards and on a prefix the Ingress already publishes (SUP-479).
 *
 * `AuthModule` for those guards. It imports `MailModule` and `AnalyticsModule`
 * itself, which this module already needed for the report, and it knows nothing
 * about health — so there is no cycle to break here, unlike `InviteCodesCsvModule`.
 */
@Module({
  imports: [MailModule, AnalyticsModule, AuthModule],
  controllers: [HealthController, AdminHealthController],
  providers: [HealthService],
})
export class HealthModule {}
