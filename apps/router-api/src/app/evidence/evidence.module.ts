import { Global, Module } from '@nestjs/common';
import { EvidenceCoverageStatsService } from './coverage.service.js';
import { EvidenceController } from './evidence.controller.js';
import { EvidenceService } from './evidence.service.js';
import { EvidencePollerService } from './evidence-poller.service.js';

/**
 * Evidence retrieval, storage and exposure.
 *
 * Global because the console resolvers and the activity aggregates read the same
 * snapshots the poller writes, and there is exactly one set of endpoints per
 * process.
 */
@Global()
@Module({
  controllers: [EvidenceController],
  providers: [EvidenceService, EvidencePollerService, EvidenceCoverageStatsService],
  exports: [EvidenceService, EvidencePollerService, EvidenceCoverageStatsService],
})
export class EvidenceModule {}
