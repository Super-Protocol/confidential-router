import { Field, GraphQLISODateTime, Int, ObjectType } from '@nestjs/graphql';

/*
 * The operator-side credential census (SUP-454). Counts and one timestamp — no
 * key material of any kind, not even a prefix: the questions these types exist
 * to answer are "how many" and "who must re-issue", and neither needs anything
 * that identifies a credential.
 *
 * `AccountApiKeys` hangs off `AdminSignUp`, so the one list of accounts the
 * console has can say who holds a key. `ApiKeyPopulation` is its own
 * admin-guarded query, because a deployment total cannot be summed out of a page.
 *
 * Both count keys a person created. The console's own chat credential is left
 * out — nobody re-issues it, the Chat screen rotates its own — which is why these
 * are not the row count of `api_keys`; see `personalKeyCondition`.
 */

@ObjectType('AccountApiKeys', {
  description: 'How many /v1 credentials one account holds. Counts only — no key material of any kind.',
})
export class AccountApiKeysModel {
  @Field(() => Int, {
    description:
      'Person-created keys in the account’s workspaces, revoked and expired ones included. ' +
      'The console’s own chat credential is not counted.',
  })
  total!: number;

  @Field(() => Int, { description: 'Of those, the ones that would authenticate right now.' })
  live!: number;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'Most recent use across those keys; null if none was ever used.',
  })
  lastUsedAt!: Date | null;
}

@ObjectType('ApiKeyPopulation', {
  description: 'Deployment-wide credential counts, for sizing and announcing a key-affecting change.',
})
export class ApiKeyPopulationModel {
  @Field(() => Int, {
    description:
      'Every person-created key on the deployment, whatever its state. Not the row count of `api_keys`: ' +
      'the console’s own chat credential is left out.',
  })
  keys!: number;

  @Field(() => Int, { description: 'Of those, the ones that would authenticate right now.' })
  liveKeys!: number;

  @Field(() => Int, {
    description:
      'Accounts holding at least one live key — who would have to re-issue. Exactly ' +
      '`adminSignUps(holdsLiveApiKey: true).totalCount` with no other filter applied, ' +
      'so the number and the page agree.',
  })
  accountsHoldingLiveKey!: number;

  @Field(() => Int, {
    description:
      'Live keys whose workspace has no member this deployment can name — the remainder no account list ' +
      'can show, and the one number here an operator cannot act on. Normally 0.',
  })
  liveKeysWithoutAccount!: number;
}
