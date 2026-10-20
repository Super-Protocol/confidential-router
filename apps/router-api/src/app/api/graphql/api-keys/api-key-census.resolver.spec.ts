import { GUARDS_METADATA } from '@nestjs/common/constants';
import { GraphQLObjectType } from 'graphql';
import { describe, expect, it } from 'vitest';
import type { ApiKeyCensusService, ApiKeyPopulation } from '../../../api-keys/index.js';
import { AdminGuard, SessionGuard } from '../../../auth/index.js';
import { buildConsoleSchema } from '../console-schema.js';
import { ApiKeyCensusResolver } from './api-key-census.resolver.js';

/**
 * The operator-only credential census (SUP-454): that the query is behind
 * `auth.adminEmails` — the whole reason it may read across workspaces the caller
 * is not a member of — that it answers counts, and that counts are all it can
 * ever answer.
 */

const POPULATION: ApiKeyPopulation = {
  keys: 9,
  liveKeys: 7,
  accountsHoldingLiveKey: 5,
  liveKeysWithoutAccount: 1,
};

describe('adminApiKeyPopulation', () => {
  it('is behind the session and the admin guard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ApiKeyCensusResolver)).toEqual([SessionGuard, AdminGuard]);
  });

  it('answers the deployment-wide counts', async () => {
    const census = { totals: async () => POPULATION } as unknown as ApiKeyCensusService;

    expect(await new ApiKeyCensusResolver(census).population()).toEqual(POPULATION);
  });

  /**
   * The acceptance condition of SUP-454: an operator sizes and announces a
   * key-affecting change without being handed a credential. Read off the built
   * schema rather than the classes, so a field added to either census type later
   * has to justify itself against this test.
   */
  it('puts no key material on either census type', async () => {
    const schema = await buildConsoleSchema();

    const fields = ['AccountApiKeys', 'ApiKeyPopulation'].flatMap((name) => {
      const type = schema.getType(name);
      expect(type, `${name} is missing from the console schema`).toBeInstanceOf(GraphQLObjectType);
      return Object.keys((type as GraphQLObjectType).getFields());
    });

    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field, `${field} reads like key material`).not.toMatch(/secret|hash|prefix|token/i);
    }
  });
});
