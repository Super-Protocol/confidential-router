import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { EvidenceService } from './evidence.service.js';

/**
 * Raw passthrough of what an endpoint published, for tooling that would
 * otherwise have to know the platform's ingress hostname.
 *
 * Deliberately unauthenticated: the platform serves the same document publicly
 * at `https://<hostname>/.well-known/swarm-evidence`, and a gatekeeper user
 * comparing what the router shows with what the host serves should not need an
 * API key to do it. Just as deliberately, the response is the bundle and
 * nothing else — no verdict, no "valid" flag (ADR-002).
 */
@ApiTags('evidence')
@Controller('v1/evidence')
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  @Get(':endpoint')
  @ApiOperation({
    summary: 'Latest evidence bundle the platform published for a router endpoint',
    description:
      'Returns the most recently issued bundle this router has fetched, exactly as published. ' +
      'Verification is the caller’s job: this router never validates the signature.',
  })
  @ApiParam({ name: 'endpoint', description: 'Endpoint name or hostname.' })
  @ApiOkResponse({ description: 'The published bundle.', schema: { type: 'object', additionalProperties: true } })
  @ApiNotFoundResponse({ description: 'No such endpoint, or nothing published for it yet.' })
  async latest(@Param('endpoint') endpointRef: string): Promise<Record<string, unknown>> {
    const endpoint = await this.evidence.endpointByNameOrHostname(endpointRef);
    if (!endpoint) {
      throw new NotFoundException(`Unknown endpoint "${endpointRef}".`);
    }
    const snapshot = await this.evidence.latestFor(endpoint.id);
    if (!snapshot) {
      // "Nothing has been published for this endpoint yet" and "this endpoint
      // does not exist" are the same 404 on purpose: both mean there is no
      // bundle to hand back, and the console already distinguishes them.
      throw new NotFoundException(`No evidence has been published for endpoint "${endpoint.name}" yet.`);
    }
    return snapshot.bundle;
  }
}
