import { Global, Module } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';

/**
 * Global: the gateway, the console resolvers and the metering writer all need
 * the same resolved catalogue, and there is exactly one config per process.
 */
@Global()
@Module({
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
