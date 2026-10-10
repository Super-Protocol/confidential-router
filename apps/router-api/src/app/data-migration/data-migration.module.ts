import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/index.js';
import { EvidenceModule } from '../evidence/index.js';
import { DataExportService } from './data-export.service.js';
import { DataImportService } from './data-import.service.js';
import { DataMigrationController } from './data-migration.controller.js';

/** The deployment export and its import — the redeploy migration path (SUP-271). */
@Module({
  imports: [AuthModule, EvidenceModule],
  controllers: [DataMigrationController],
  providers: [DataExportService, DataImportService],
})
export class DataMigrationModule {}
