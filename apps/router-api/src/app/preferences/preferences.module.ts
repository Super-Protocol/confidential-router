import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/index.js';
import { Endpoint } from '../db/entities/endpoint.entity.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { Generation } from '../db/entities/generation.entity.js';
import { UserPreferences } from '../db/entities/user-preferences.entity.js';
import { EvidenceExportService } from './evidence-export.service.js';
import { ExportsController } from './preferences.controller.js';
import { PreferencesService } from './preferences.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([UserPreferences, Generation, EvidenceSnapshot, Endpoint]), AuthModule],
  controllers: [ExportsController],
  providers: [PreferencesService, EvidenceExportService],
  exports: [PreferencesService, EvidenceExportService],
})
export class PreferencesModule {}
