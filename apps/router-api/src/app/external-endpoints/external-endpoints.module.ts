import { Global, Module } from '@nestjs/common';
import { ExternalCatalogService } from './external-catalog.service.js';
import { ExternalEndpointAdminService } from './external-endpoint-admin.service.js';
import { ExternalEndpointStatusService } from './external-endpoint-status.service.js';
import { ExternalEndpointStatusPollerService } from './external-endpoint-status-poller.service.js';
import { ExternalEvidenceService } from './external-evidence.service.js';
import { ExternalEvidencePollerService } from './external-evidence-poller.service.js';
import { SidecarConfigWriterService } from './sidecar-config-writer.service.js';

/**
 * External model endpoints: the config the egress sidecar runs on, the verdicts
 * it reports back, and the catalogue of models those verdicts admit (ADR-008).
 *
 * Global for the same reason `CatalogModule` is: the gateway, the console
 * resolvers and the metering writer all need the same resolved catalogue, and
 * there is exactly one sidecar per process.
 */
@Global()
@Module({
  providers: [
    SidecarConfigWriterService,
    ExternalCatalogService,
    ExternalEndpointStatusService,
    ExternalEndpointStatusPollerService,
    ExternalEvidenceService,
    ExternalEvidencePollerService,
    ExternalEndpointAdminService,
  ],
  exports: [
    SidecarConfigWriterService,
    ExternalCatalogService,
    ExternalEndpointStatusService,
    ExternalEndpointStatusPollerService,
    ExternalEvidenceService,
    ExternalEvidencePollerService,
    ExternalEndpointAdminService,
  ],
})
export class ExternalEndpointsModule {}
