import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [MailModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
