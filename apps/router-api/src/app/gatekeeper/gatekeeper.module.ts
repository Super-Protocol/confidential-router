import { Module } from '@nestjs/common';
import { GatekeeperReleaseService } from './gatekeeper-release.service.js';

/**
 * The Gatekeeper screen's one dependency: which build of the verifying proxy to
 * download. Deliberately the whole module — the router publishes evidence and
 * nothing more, so there is no gatekeeper registration, instance list or status
 * for it to own (ADR-002).
 */
@Module({
  providers: [GatekeeperReleaseService],
  exports: [GatekeeperReleaseService],
})
export class GatekeeperModule {}
