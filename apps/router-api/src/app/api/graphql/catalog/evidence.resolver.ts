import { UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser, SessionGuard, type SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import { EvidenceCoverageStatsService, EvidenceService, snapshotCursor } from '../../../evidence/index.js';
import {
  DigestChangeModel,
  EvidenceCoverageArgs,
  EvidenceCoverageModel,
  EvidenceSnapshotConnectionModel,
  EvidenceSnapshotModel,
} from './evidence.model.js';

/**
 * The evidence modal, and the one metric derived from evidence.
 *
 * Everything here is retrieval: the history of what an endpoint published, the
 * bundle itself for export, and a re-poll on demand. There is no field, argument
 * or mutation through which a verdict could enter — verification happens in the
 * user's gatekeeper (ADR-002).
 */
@Resolver(() => EvidenceSnapshotModel)
@UseGuards(SessionGuard)
export class EvidenceResolver {
  constructor(
    private readonly evidence: EvidenceService,
    private readonly coverage: EvidenceCoverageStatsService,
    private readonly workspaces: WorkspaceScopeService,
  ) {}

  @Query(() => EvidenceSnapshotConnectionModel, {
    name: 'evidenceSnapshots',
    description: 'Everything this endpoint has published, newest first.',
  })
  async evidenceSnapshots(
    @Args('endpointId', { type: () => ID }) endpointId: string,
    @Args('first', { type: () => Int, defaultValue: 20 }) first: number,
    @Args('after', { nullable: true }) after?: string,
  ): Promise<EvidenceSnapshotConnectionModel> {
    await this.evidence.endpointOrThrow(endpointId);
    const now = new Date();
    const page = await this.evidence.snapshots(endpointId, first, after);
    return {
      edges: page.nodes.map((node) => ({
        cursor: snapshotCursor(node),
        node: EvidenceSnapshotModel.from(node, now),
      })),
      pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
    };
  }

  @Query(() => [DigestChangeModel], {
    name: 'evidenceDigestHistory',
    description: 'Each distinct digest this endpoint has published — when a pinned value would have had to change.',
  })
  async evidenceDigestHistory(
    @Args('endpointId', { type: () => ID }) endpointId: string,
    @Args('limit', { type: () => Int, defaultValue: 20 }) limit: number,
  ): Promise<DigestChangeModel[]> {
    await this.evidence.endpointOrThrow(endpointId);
    return (await this.evidence.digestHistory(endpointId, limit)).map(DigestChangeModel.from);
  }

  @Query(() => EvidenceCoverageModel, {
    name: 'evidenceCoverage',
    description: 'Share of the workspace’s generations served while the endpoint had a fresh bundle published.',
  })
  async evidenceCoverage(
    @CurrentUser() user: SessionUser,
    @Args() args: EvidenceCoverageArgs,
  ): Promise<EvidenceCoverageModel> {
    const workspace = await this.workspaces.requireMembership(user.id, args.workspaceId);
    return EvidenceCoverageModel.from(
      await this.coverage.summary({
        workspaceId: workspace.id,
        from: args.from,
        to: args.to,
        endpointId: args.endpointId,
      }),
    );
  }

  /**
   * "Fetch fresh quote": re-poll this endpoint now.
   *
   * Returns the snapshot that is current after the fetch. A fetch that fails
   * returns the last known snapshot (or null) rather than an error — the button
   * reports what the endpoint publishes, and "nothing right now" is an answer.
   */
  @Mutation(() => EvidenceSnapshotModel, { name: 'refreshEvidence', nullable: true })
  async refreshEvidence(
    @Args('endpointId', { type: () => ID }) endpointId: string,
  ): Promise<EvidenceSnapshotModel | null> {
    const endpoint = await this.evidence.endpointOrThrow(endpointId);
    const now = new Date();
    try {
      return EvidenceSnapshotModel.from(await this.evidence.refresh(endpoint, now), now);
    } catch (error) {
      this.evidence.logFetchFailure(endpoint, error);
      const latest = await this.evidence.latestFor(endpoint.id);
      return latest ? EvidenceSnapshotModel.from(latest, now) : null;
    }
  }
}
