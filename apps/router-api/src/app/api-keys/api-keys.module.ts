import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../db/entities/api-key.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { WorkspaceMember } from '../db/entities/workspace-member.entity.js';
import { ApiKeyService } from './api-key.service.js';
import { ApiKeyCensusService } from './api-key-census.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, Workspace, WorkspaceMember])],
  providers: [ApiKeyService, ApiKeyCensusService],
  exports: [ApiKeyService, ApiKeyCensusService],
})
export class ApiKeysModule {}
