import { Global, Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { routerConfig } from '../config.js';
import { buildDataSourceOptions, ensureSqliteDirectory } from './data-source.js';

/**
 * Global so every feature module can inject repositories without re-importing
 * it; there is exactly one database in this service (ADR-004 §2).
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [routerConfig.KEY],
      useFactory: (config: ConfigType<typeof routerConfig>) => {
        if (config.database.type === 'sqlite') {
          ensureSqliteDirectory(config.database.file);
        }
        return {
          ...buildDataSourceOptions(config.database),
          migrationsRun: config.database.migrationsRun,
        };
      },
    }),
  ],
  exports: [TypeOrmModule],
})
export class DbModule {}
