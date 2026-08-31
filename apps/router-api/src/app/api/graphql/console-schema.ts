import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { type GraphQLSchema, lexicographicSortSchema, printSchema } from 'graphql';
import { ActivityResolver } from './activity/activity.resolver.js';
import { ApiKeysResolver } from './api-keys/api-keys.resolver.js';
import { SignInOptionsResolver } from './auth/sign-in-options.resolver.js';
import { CatalogResolver } from './catalog/catalog.resolver.js';
import { EvidenceResolver } from './catalog/evidence.resolver.js';
import { CreditsResolver } from './credits/credits.resolver.js';
import { GatekeeperResolver } from './gatekeeper/gatekeeper.resolver.js';
import { PreferencesResolver } from './preferences/preferences.resolver.js';
import { JsonScalar } from './scalars/json.scalar.js';
import { ViewerResolver } from './viewer/viewer.resolver.js';

/**
 * Every resolver in the console schema, and the one custom scalar.
 *
 * The list is the schema's contents: `GraphQLApiModule` registers exactly these
 * as providers, and `buildConsoleSchema` builds the SDL from exactly these. One
 * array rather than two, so a resolver cannot be wired into the running API
 * without appearing in the committed `schema.graphql` — which is the drift the
 * check in `schema.spec.ts` exists to catch.
 */
export const CONSOLE_RESOLVERS = [
  ActivityResolver,
  ApiKeysResolver,
  CatalogResolver,
  CreditsResolver,
  EvidenceResolver,
  GatekeeperResolver,
  PreferencesResolver,
  SignInOptionsResolver,
  ViewerResolver,
] as const;

export const CONSOLE_SCALARS = [JsonScalar] as const;

/** Where the emitted SDL is committed, relative to the repository root. */
export const CONSOLE_SCHEMA_PATH = 'apps/router-api/schema.graphql';

/**
 * Builds the schema from the resolver metadata alone.
 *
 * No database, no config and no HTTP: `GraphQLSchemaFactory` reads decorators
 * and never instantiates a resolver, so the SDL can be printed on a laptop with
 * nothing else running — which is what makes it cheap enough to check on every
 * CI run.
 */
export async function buildConsoleSchema(): Promise<GraphQLSchema> {
  const app = await NestFactory.create(GraphQLSchemaBuilderModule, { logger: false });
  await app.init();
  try {
    return await app.get(GraphQLSchemaFactory).create([...CONSOLE_RESOLVERS], [...CONSOLE_SCALARS]);
  } finally {
    await app.close();
  }
}

/**
 * The canonical SDL text.
 *
 * Sorted lexicographically, so the committed file is a function of the schema
 * and not of the order resolvers happen to be registered in — a reordered
 * provider list must not produce a diff, and a renamed field must.
 */
export function printConsoleSchema(schema: GraphQLSchema): string {
  return `${printSchema(lexicographicSortSchema(schema)).trim()}\n`;
}
