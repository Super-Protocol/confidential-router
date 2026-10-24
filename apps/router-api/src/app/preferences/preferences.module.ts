import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/index.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { Generation } from '../db/entities/generation.entity.js';
import { UserPreferences } from '../db/entities/user-preferences.entity.js';
import { EvidenceExportService } from './evidence-export.service.js';
import { EvidenceRetentionService } from './evidence-retention.service.js';
import { EvidenceRetentionHealth } from './evidence-retention-health.js';
import { ExportsController } from './preferences.controller.js';
import { PreferencesService } from './preferences.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserPreferences, Generation, EvidenceSnapshot, Endpoint, ExternalEndpoint]),
    AuthModule,
  ],
  controllers: [ExportsController],
  providers: [PreferencesService, EvidenceExportService, EvidenceRetentionService, EvidenceRetentionHealth],
  // `EvidenceRetentionHealth` is exported for `/health` alone: the sweep itself
  // is driven by its own timer and has no caller to hand out.
  exports: [PreferencesService, EvidenceExportService, EvidenceRetentionHealth],
})
export class PreferencesModule {}
