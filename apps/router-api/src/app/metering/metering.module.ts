import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { EvidenceSnapshot } from '../db/entities/evidence-snapshot.entity.js';
import { Generation } from '../db/entities/generation.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { CREDITS_GATEWAY, WorkspaceBalanceCreditsGateway } from './credits.gateway.js';
import { EvidenceCoverageService } from './evidence-coverage.service.js';
import { MeteringService } from './metering.service.js';

/**
 * `CREDITS_GATEWAY` is bound here and nowhere else: SUP-75 swaps the ledger
 * implementation in by changing this one provider.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Generation, EvidenceSnapshot, Workspace]), ApiKeysModule],
  providers: [
    { provide: CREDITS_GATEWAY, useClass: WorkspaceBalanceCreditsGateway },
    EvidenceCoverageService,
    MeteringService,
  ],
  exports: [CREDITS_GATEWAY, EvidenceCoverageService, MeteringService],
})
export class MeteringModule {}
