import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { EmailCodeThrottle } from './email-code-throttle.js';
import { MailService } from './mail.service.js';
import { resolveMailSettings } from './mail-settings.js';
import { createMailTransport, MAIL_TRANSPORT } from './mail-transport.js';

/**
 * Outbound mail (SUP-269). Imported by `AuthModule`, whose flows send the
 * mail, and by `HealthModule`, which reports whether it is getting through.
 *
 * `MAIL_TRANSPORT` is the only thing that leaves the process, so it is the one
 * provider the e2e harness replaces; rendering and the throttles run for real.
 */
@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [routerConfig.KEY],
      useFactory: (config: ConfigType<typeof routerConfig>) => createMailTransport(resolveMailSettings(config)),
    },
    MailService,
    EmailCodeThrottle,
  ],
  exports: [MailService, EmailCodeThrottle],
})
export class MailModule {}
