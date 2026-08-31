import { UseGuards } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';
import { SessionGuard } from '../../../auth/index.js';
import { GatekeeperReleaseService } from '../../../gatekeeper/index.js';
import { GatekeeperReleaseModel } from './gatekeeper.model.js';

/**
 * The Gatekeeper screen: download the verifying proxy.
 *
 * One query, no arguments, no workspace — the release is the same artefact for
 * everyone, and there is deliberately nothing here to register a gatekeeper
 * with or report a verdict to (ADR-002).
 */
@Resolver(() => GatekeeperReleaseModel)
@UseGuards(SessionGuard)
export class GatekeeperResolver {
  constructor(private readonly releases: GatekeeperReleaseService) {}

  @Query(() => GatekeeperReleaseModel, {
    name: 'gatekeeperRelease',
    nullable: true,
    description: 'The published gatekeeper build, or null when none has been retrieved yet.',
  })
  async gatekeeperRelease(): Promise<GatekeeperReleaseModel | null> {
    const release = await this.releases.latest();
    return release ? GatekeeperReleaseModel.from(release) : null;
  }
}
