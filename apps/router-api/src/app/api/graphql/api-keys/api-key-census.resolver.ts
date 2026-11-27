import { UseGuards } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';
import { ApiKeyCensusService } from '../../../api-keys/index.js';
import { AdminGuard, SessionGuard } from '../../../auth/index.js';
import { ApiKeyPopulationModel } from './api-key-census.model.js';

/**
 * How many `/v1` credentials this deployment holds, for an operator (SUP-454).
 *
 * A class of its own rather than a query on {@link ApiKeysResolver}, which is
 * `SessionGuard` alone and tenant-scoped on every field: this one reads across
 * every workspace, including ones the caller is not a member of, so it carries
 * `AdminGuard` at the class level where it cannot be forgotten on a later field.
 * The same split {@link InviteAdminResolver} has from `InvitesResolver`.
 *
 * It exists because nothing else could answer it. `apiKeys(workspaceId)` calls
 * `requireMembership`, so an operator asking about someone else's workspace gets
 * a 403 — which is why the SUP-434 rebuild voided eight accounts' keys and stayed
 * invisible for a week, with the credit ledger the only trace. Who holds what is
 * on `adminSignUps`; this is the total those pages cannot be summed into.
 */
@Resolver()
@UseGuards(SessionGuard, AdminGuard)
export class ApiKeyCensusResolver {
  constructor(private readonly census: ApiKeyCensusService) {}

  @Query(() => ApiKeyPopulationModel, {
    name: 'adminApiKeyPopulation',
    description: 'Deployment-wide API-key counts. No key material. Restricted to auth.adminEmails.',
  })
  async population(): Promise<ApiKeyPopulationModel> {
    return this.census.totals();
  }
}
