import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { BillingModule, LedgerCreditsGateway } from '../billing/index.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { Generation } from '../db/entities/generation.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { CREDITS_GATEWAY } from './credits.gateway.js';
import { EvidenceCoverageService } from './evidence-coverage.service.js';
import { MeteringService } from './metering.service.js';

/**
 * `CREDITS_GATEWAY` is bound here and nowhere else. `useExisting` rather than
 * `useClass`: billing owns the ledger's lifecycle, and a second instance of it
 * would mean a second in-process write queue — see `LedgerService.serialize`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Generation, EvidenceSnapshot, Workspace]), ApiKeysModule, BillingModule],
  providers: [
    { provide: CREDITS_GATEWAY, useExisting: LedgerCreditsGateway },
    EvidenceCoverageService,
    MeteringService,
  ],
  exports: [CREDITS_GATEWAY, EvidenceCoverageService, MeteringService],
})
export class MeteringModule {}
