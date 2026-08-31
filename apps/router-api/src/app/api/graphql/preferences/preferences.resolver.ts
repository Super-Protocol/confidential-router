import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { CurrentUser, SessionGuard, type SessionUser, WorkspaceScopeService } from '../../../auth/index.js';
import { EvidenceExportService, PreferencesService } from '../../../preferences/index.js';
import {
  EvidenceExportModel,
  ExportEvidenceArgs,
  preferencesModel,
  UpdatePreferencesInput,
  UserPreferencesModel,
} from './preferences.model.js';

/**
 * The Preferences screen's writes. The read is `me { preferences }` — one
 * query for the whole screen, and one place a setting can come from.
 */
@Resolver()
@UseGuards(SessionGuard)
export class PreferencesResolver {
  constructor(
    private readonly preferences: PreferencesService,
    private readonly exports: EvidenceExportService,
    private readonly workspaces: WorkspaceScopeService,
  ) {}

  @Mutation(() => UserPreferencesModel, { description: 'Updates the settings named; leaves the rest alone.' })
  async updatePreferences(
    @CurrentUser() user: SessionUser,
    @Args('input') input: UpdatePreferencesInput,
  ): Promise<UserPreferencesModel> {
    return preferencesModel(await this.preferences.update(user.id, input));
  }

  /**
   * Mints the auditor's download link.
   *
   * The archive is not built here: it is built when the link is followed, so a
   * mutation cannot be turned into a way to spend the server's memory, and the
   * link can be handed to someone who has no console session.
   */
  @Mutation(() => EvidenceExportModel, { description: 'An expiring link to the evidence for a period.' })
  async exportEvidence(
    @CurrentUser() user: SessionUser,
    @Args() args: ExportEvidenceArgs,
  ): Promise<EvidenceExportModel> {
    await this.workspaces.requireMembership(user.id, args.workspaceId);
    return this.exports.link({ userId: user.id, workspaceId: args.workspaceId, from: args.from, to: args.to });
  }
}
