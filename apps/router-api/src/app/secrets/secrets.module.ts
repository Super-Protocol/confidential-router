import { Global, Module } from '@nestjs/common';
import { SecretEnvelopeService } from './secret-envelope.service.js';

/**
 * Global: the external-endpoint admin API seals, the egress leg opens, and there
 * is exactly one data key per process.
 */
@Global()
@Module({
  providers: [SecretEnvelopeService],
  exports: [SecretEnvelopeService],
})
export class SecretsModule {}
