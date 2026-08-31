import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import type { Request } from 'express';
import { ActivityModule } from '../../activity/index.js';
import { ApiKeysModule } from '../../api-keys/api-keys.module.js';
import { AuthModule } from '../../auth/index.js';
import { BillingModule } from '../../billing/index.js';
import { routerConfig } from '../../config.js';
import { GatekeeperModule } from '../../gatekeeper/index.js';
import { PreferencesModule } from '../../preferences/index.js';
import { CatalogViewService } from './catalog/catalog-view.service.js';
import { CONSOLE_RESOLVERS, CONSOLE_SCALARS } from './console-schema.js';
import { formatConsoleError } from './errors.js';

/**
 * Code-first Apollo schema for the console. The OpenAI-compatible `/v1` surface
 * is REST and lives elsewhere — this module is only what the console needs.
 *
 * The provider list is `CONSOLE_RESOLVERS`, the same array the SDL is printed
 * from, so `schema.graphql` cannot fall behind the running API without the
 * drift check failing.
 */
@Module({
  imports: [
    ApiKeysModule,
    AuthModule,
    ActivityModule,
    BillingModule,
    GatekeeperModule,
    PreferencesModule,
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
        // A GraphQL response is 200 whatever happened, so `extensions.code` is
        // the only thing a client can branch on.
        formatError: (formatted, raw) => formatConsoleError(formatted, raw, config.graphql.introspection),
        // Apollo's own CSRF guard is off because Nest's CORS allowlist plus the
        // `SameSite=Lax` session cookie already cover it (ADR-004 §4), and
        // leaving it on would reject the console's simple GET queries.
        csrfPrevention: false,
        context: ({ req }: { req: Request }) => ({ req }),
      }),
    }),
  ],
  providers: [...CONSOLE_RESOLVERS, ...CONSOLE_SCALARS, CatalogViewService],
})
export class GraphQLApiModule {}
