import { createPinoHttpConfig } from '@confidential-router/server-common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import pinoPretty from 'pino-pretty';
import { GraphQLApiModule } from './api/graphql/graphql-api.module.js';
import { RestApiModule } from './api/rest-api.module.js';
import { AuthModule } from './auth/index.js';
import { routerConfig } from './config.js';
import { DbModule } from './db/db.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [routerConfig], cache: true }),
    LoggerModule.forRootAsync({
      inject: [routerConfig.KEY],
      useFactory: (config: ConfigType<typeof routerConfig>) => {
        const options = createPinoHttpConfig({
          level: config.log.level,
          // Health probes fire every few seconds and would otherwise dominate
          // the log. They still get a request id — the middleware stays on.
          quietPathPrefixes: ['/health'],
        });
        // A stream rather than `transport: 'pino-pretty'`: transports run in a
        // worker thread loaded from disk, which the single-file bundle has not
        // got. Production emits JSON and never touches this path.
        return { pinoHttp: config.log.pretty ? [options, pinoPretty({ singleLine: true })] : options };
      },
    }),
    DbModule,
    AuthModule,
    RestApiModule,
    GraphQLApiModule,
  ],
})
export class AppModule {}
