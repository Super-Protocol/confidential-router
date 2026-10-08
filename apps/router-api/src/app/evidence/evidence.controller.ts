import { Controller, Get, Header, NotFoundException, Param, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Endpoint } from '../db/entities/endpoint.entity.js';
import type { ExternalEndpoint } from '../db/entities/external-endpoint.entity.js';
import { ExternalEvidenceService } from '../external-endpoints/external-evidence.service.js';
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
 *
 * **It is also the only way a browser can read that document at all** (SUP-191).
 * The well-known path is served by the platform's own gateway, which sits below
 * this service's CORS layer and sends no `Access-Control-Allow-Origin` — so a
 * console on one host cannot read the evidence of an API on another, and the
 * chat's tier-1 gate would have nothing to verify. These routes are `/v1/*` on
 * the API host, so they go through `configureApp`'s `validClientOrigins` and do
 * carry the header. Nothing about authenticity rests on that: the document is a
 * JWS over its own bytes, and the browser checks the signature either way —
 * which is why relaying it is a transport fix and not a trust decision.
 *
 * `Cache-Control: no-store` on both routes. A bundle is re-signed every few
 * minutes and a reader is comparing freshness and digests with a gatekeeper
 * looking at the live host; a copy held by a browser or an intermediary is the
 * one way this surface could hand back something the deployment is no longer
 * publishing. Today the responses carry an `ETag` and no freshness at all, which
 * leaves the decision to a shared cache's heuristics.
 *
 * ## It also relays an external upstream's bundle (SUP-227, ADR-008 §7)
 *
 * `/v1/evidence/{endpoint}` takes the name of a registered external endpoint and
 * hands back the publication that endpoint's last verdict named, under the same
 * rules: verbatim, no verdict, `no-store`, and the same 404/503 split. That is
 * what lets the inspect panel run **the browser's own** tier-1 verification on
 * another deployment's evidence and draw its measurements and deployment graph —
 * the per-user mitigation for the one thing pinning this router cannot cover
 * (ADR-008 §1: the trust list is database state, not part of the canonical
 * snapshot).
 *
 * Unauthenticated, like the own-endpoint route, and the reasoning is the same
 * document-shaped one rather than an oversight. What is relayed is a JWS the
 * *upstream* publishes at its own public `/.well-known/swarm-evidence`; this
 * router adds nothing to it and asserts nothing about it. Ruling 3 on SUP-221
 * keeps endpoint URLs and verdict detail out of the anonymous **catalogue**, and
 * that holds — `Model.externalUpstream` is null without a session. A caller here
 * must already know the endpoint name, and what it learns is a document its
 * publisher serves to the world.
 */
@ApiTags('evidence')
@Controller('v1/evidence')
export class EvidenceController {
  constructor(
    private readonly evidence: EvidenceService,
    private readonly externalEvidence: ExternalEvidenceService,
  ) {}

  /**
   * This deployment's own evidence, without the caller having to learn an
   * internal endpoint name first — which is the form an operator, a `curl` and a
   * gatekeeper user all want. See `EvidenceService.ownEndpoint` for what "own"
   * resolves to and when it refuses to guess.
   *
   * Declared before `:endpoint` for reading order only; Express matches `/` and
   * `/:endpoint` on different path lengths, so neither can shadow the other.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Latest evidence bundle the platform published for this deployment',
    description:
      'The same document as `/v1/evidence/{endpoint}` for the endpoint this router publishes on, ' +
      'relayed exactly as it was retrieved. Verification is the caller’s job: this router never ' +
      'validates the signature.',
  })
  @ApiOkResponse({ description: 'The published bundle.', schema: { type: 'object', additionalProperties: true } })
  @ApiNotFoundResponse({ description: 'This router cannot tell which of its endpoints is its own.' })
  @ApiServiceUnavailableResponse({ description: 'No bundle has been retrieved for it yet.' })
  async own(): Promise<Record<string, unknown>> {
    const endpoint = await this.evidence.ownEndpoint();
    if (!endpoint) {
      throw new NotFoundException(
        'This router cannot tell which of its endpoints is its own. Name one: /v1/evidence/{endpoint}.',
      );
    }
    return this.bundleOf(endpoint);
  }

  /**
   * One endpoint's bundle, ours or an upstream's.
   *
   * Our own endpoints are resolved first, and the precedence is not arbitrary:
   * the two name spaces are separate tables on purpose
   * (`external_endpoints.name`, "a name collision between a host we publish
   * evidence for and a host we verify would be a trust confusion"), so a value
   * that matches both is a misconfiguration — and the safe reading of it is the
   * one where this deployment answers for itself.
   */
  @Get(':endpoint')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Latest evidence bundle published for a router endpoint or an external upstream',
    description:
      'Returns the most recently issued bundle this router has fetched, exactly as published. For an external ' +
      'endpoint it is the publication that endpoint’s last verdict named. Verification is the caller’s job: ' +
      'this router never validates the signature, and this response carries no verdict.',
  })
  @ApiParam({ name: 'endpoint', description: 'Router endpoint name or hostname, or external endpoint name.' })
  @ApiOkResponse({ description: 'The published bundle.', schema: { type: 'object', additionalProperties: true } })
  @ApiNotFoundResponse({ description: 'No such endpoint.' })
  @ApiServiceUnavailableResponse({ description: 'Nothing has been retrieved for this endpoint yet.' })
  async latest(@Param('endpoint') endpointRef: string): Promise<Record<string, unknown>> {
    const endpoint = await this.evidence.endpointByNameOrHostname(endpointRef);
    if (endpoint) {
      return this.bundleOf(endpoint);
    }
    const external = await this.externalEvidence.endpointByNameOrHostname(endpointRef);
    if (external) {
      return this.externalBundleOf(external);
    }
    throw new NotFoundException(`Unknown endpoint "${endpointRef}".`);
  }

  /**
   * The stored bundle, verbatim, or a typed statement of why there is none.
   *
   * "This endpoint does not exist" (404) and "nothing has been retrieved for it
   * yet" (503) used to be the same 404 here, on the grounds that both mean there
   * is no bundle to hand back. For the console that was true — it knows its own
   * endpoints. For the chat's gate it was not: a deployment still waiting on its
   * first poll produced "this router answered status 404", which reads as the
   * router denying the endpoint rather than as a few seconds of waiting. So the
   * second case now says what it is, with a `reason` a screen can branch on
   * rather than a sentence it would have to parse.
   *
   * Never an empty 200: a caller that verifies what it is handed must not have
   * to tell a bundle from the absence of one.
   */
  private async bundleOf(endpoint: Endpoint): Promise<Record<string, unknown>> {
    const snapshot = await this.evidence.latestFor(endpoint.id);
    if (!snapshot) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        reason: 'evidence_not_fetched',
        message:
          `This router has not yet retrieved evidence for endpoint "${endpoint.name}". ` +
          `The platform publishes it at https://${endpoint.hostname}/.well-known/swarm-evidence.`,
      });
    }
    return snapshot.bundle;
  }

  /**
   * An upstream's stored publication, verbatim, or the same typed 503.
   *
   * Deliberately indifferent to the endpoint's current status — but only ever the
   * *approved* deployment's publication (SUP-252: the digest an admin pinned). A
   * `denied` or `disabled` upstream still has the publication its admin approved, and
   * handing it back is not a claim that the router would route there now — this
   * surface has never carried a verdict in either direction (ADR-002), and the
   * screens that *do* carry one say *denied by this router* in so many words
   * (ADR-008 §1). Refusing here instead would make the relay the third place a
   * verdict is expressed, and the least legible of the three.
   */
  private async externalBundleOf(endpoint: ExternalEndpoint): Promise<Record<string, unknown>> {
    const snapshot = await this.externalEvidence.latestAdmitted(endpoint);
    if (!snapshot) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        reason: 'evidence_not_fetched',
        message:
          `This router has not yet retrieved evidence for external endpoint "${endpoint.name}". ` +
          `Its platform publishes it at https://${endpoint.hostname}/.well-known/swarm-evidence.`,
      });
    }
    return snapshot.bundle;
  }
}
