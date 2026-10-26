import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InMemoryTokenBucketRateLimiter } from '../api/v1/rate-limiter.js';
import { routerConfig } from '../config.js';
import { MailAddressState } from '../db/entities/mail-address-state.entity.js';
import { User } from '../db/entities/user.entity.js';
import { EmailCodeThrottle } from './email-code-throttle.js';
import { MailService } from './mail.service.js';
import { MailDeliveryService } from './mail-delivery.service.js';
import { MAIL_RATE_LIMITER } from './mail-rate-limiter.js';
import { resolveMailSettings } from './mail-settings.js';
import { createMailTransport, MAIL_TRANSPORT } from './mail-transport.js';
import { MailWebhookController } from './mail-webhook.controller.js';

/**
 * Outbound mail (SUP-269) and what the provider says came of it (SUP-551).
 * Imported by `AuthModule`, whose flows send the mail, by `HealthModule`, which
 * reports whether it is getting through, and by `GraphQLApiModule`, whose
 * `signInMailState` query is how the code-entry screen stops claiming a dropped
 * message is merely late.
 *
 * `MAIL_TRANSPORT` is the only thing that leaves the process, so it is the one
 * provider the e2e harness replaces; rendering and the throttles run for real.
 *
 * The inbound half is a webhook rather than a poll: the events are the
 * provider's and it already pushes them, and a poller would need a schedule, a
 * cursor and a leader to run on.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MailAddressState, User])],
  controllers: [MailWebhookController],
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [routerConfig.KEY],
      useFactory: (config: ConfigType<typeof routerConfig>) => createMailTransport(resolveMailSettings(config)),
    },
    { provide: MAIL_RATE_LIMITER, useClass: InMemoryTokenBucketRateLimiter },
    MailService,
    MailDeliveryService,
    EmailCodeThrottle,
  ],
  exports: [MailService, MailDeliveryService, EmailCodeThrottle, MAIL_RATE_LIMITER],
})
export class MailModule {}
