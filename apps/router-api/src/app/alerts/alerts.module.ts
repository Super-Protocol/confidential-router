import { Global, Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module.js';
import { OperatorAlertsService } from './operator-alerts.service.js';

/**
 * The outbound path for an alert (SUP-535).
 *
 * Global, because the raisers are background passes in several modules and there
 * is exactly one channel — and one rate limit — per process. A second instance
 * would be a second mailbox-flood budget, which is the one property this service
 * exists to hold.
 */
@Global()
@Module({
  imports: [MailModule],
  providers: [OperatorAlertsService],
  exports: [OperatorAlertsService],
})
export class AlertsModule {}
