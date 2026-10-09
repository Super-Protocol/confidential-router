import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { MailService } from './mail.service.js';
import { resolveMailSettings } from './mail-settings.js';
import { createMailTransport, MAIL_TRANSPORT } from './mail-transport.js';
import { PasswordResetThrottle } from './password-reset-throttle.js';

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
    PasswordResetThrottle,
  ],
  exports: [MailService, PasswordResetThrottle],
})
export class MailModule {}
