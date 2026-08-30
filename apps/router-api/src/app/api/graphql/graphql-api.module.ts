import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import type { Request } from 'express';
import { ApiKeysModule } from '../../api-keys/api-keys.module.js';
import { AuthModule } from '../../auth/index.js';
import { routerConfig } from '../../config.js';
import { ApiKeysResolver } from './api-keys/api-keys.resolver.js';
import { CatalogResolver } from './catalog/catalog.resolver.js';
import { CatalogViewService } from './catalog/catalog-view.service.js';
import { EvidenceResolver } from './catalog/evidence.resolver.js';
import { JsonScalar } from './scalars/json.scalar.js';
import { ViewerResolver } from './viewer/viewer.resolver.js';

/**
 * Code-first Apollo schema for the console. The OpenAI-compatible `/v1` surface
 * is REST and lives elsewhere — this module is only what the console needs.
 */
@Module({
  imports: [
    ApiKeysModule,
    AuthModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [routerConfig.KEY],
      useFactory: (config: ConfigType<typeof routerConfig>) => ({
        path: config.graphql.path,
        autoSchemaFile: true,
        sortSchema: true,
        introspection: config.graphql.introspection,
        // Same switch as introspection, so a production deployment stops
        // narrating its own internals in error responses.
        includeStacktraceInErrorResponses: config.graphql.introspection,
        // Apollo's own CSRF guard is off because Nest's CORS allowlist plus the
        // `SameSite=Lax` session cookie already cover it (ADR-004 §4), and
        // leaving it on would reject the console's simple GET queries.
        csrfPrevention: false,
        context: ({ req }: { req: Request }) => ({ req }),
      }),
    }),
  ],
  providers: [ApiKeysResolver, ViewerResolver, CatalogResolver, EvidenceResolver, CatalogViewService, JsonScalar],
})
export class GraphQLApiModule {}
