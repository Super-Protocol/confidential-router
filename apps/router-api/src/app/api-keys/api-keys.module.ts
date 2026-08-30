import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../db/entities/api-key.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { ApiKeyService } from './api-key.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, Workspace])],
  providers: [ApiKeyService],
  exports: [ApiKeyService],
})
export class ApiKeysModule {}
