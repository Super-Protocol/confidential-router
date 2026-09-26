import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/index.js';
import { ModelRequest } from '../db/entities/model-request.entity.js';
import { ModelRequestsController } from './model-requests.controller.js';
import { ModelRequestsService } from './model-requests.service.js';

/**
 * "Request a model": the dialog's write, and the two operator reads over it.
 *
 * `AuthModule` for `SessionGuard` and `AdminGuard`, which the CSV controller
 * puts in front of an export of every account's asks. There is no
 * `RATE_LIMITER` here, unlike `InvitesModule` and `FeedbackModule`: the budget
 * this feature needs is per account per day, and an in-process minute bucket is
 * neither — `ModelRequestsService.record` counts the rows instead.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ModelRequest]), AuthModule],
  controllers: [ModelRequestsController],
  providers: [ModelRequestsService],
  exports: [ModelRequestsService],
})
export class ModelRequestsModule {}
