import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/index.js';
import { ApiKey } from '../db/entities/api-key.entity.js';
import { Generation } from '../db/entities/generation.entity.js';
import { Model } from '../db/entities/model.entity.js';
import { ActivityController } from './activity.controller.js';
import { ActivityService } from './activity.service.js';
import { GenerationLogService } from './generation-log.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Generation, ApiKey, Model]), AuthModule],
  controllers: [ActivityController],
  providers: [ActivityService, GenerationLogService],
  exports: [ActivityService, GenerationLogService],
})
export class ActivityModule {}
