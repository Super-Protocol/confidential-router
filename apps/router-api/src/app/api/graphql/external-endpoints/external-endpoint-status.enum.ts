import { registerEnumType } from '@nestjs/graphql';
import type { ExternalEndpointStatus } from '../../../db/entities/external-endpoint.entity.js';

/**
 * The external vocabulary, and it is deliberately not the evidence one.
 *
 * ADR-002's rule — *published / fresh / stale*, never "verified" — is about the
 * router's **own** endpoints, where the router holds no verdict. Toward an external
 * upstream there is a verifying party and it is this router, so these values name
 * it: the console renders them as *verified by this router* / *denied by this
 * router* (ADR-008 §1). The two vocabularies never share a component.
 *
 * It lives in a module of its own because two unrelated types need it — the admin
 * section's `ExternalEndpoint` and the public catalogue's `ExternalUpstream`, the
 * second of which is defined beside `Model` — and a shared enum imported both ways
 * would put `catalog/` and `external-endpoints/` in an import cycle. A cycle whose
 * first symptom would be `IsEnum(undefined)` at class-definition time, which is a
 * long way from the file that caused it.
 */
export const ExternalEndpointStatusEnum = {
  PENDING: 'pending',
  VERIFIED_BY_THIS_ROUTER: 'verified',
  DENIED_BY_THIS_ROUTER: 'denied',
  DISABLED: 'disabled',
} as const satisfies Record<string, ExternalEndpointStatus>;

registerEnumType(ExternalEndpointStatusEnum, {
  name: 'ExternalEndpointStatus',
  description:
    'What this router currently says about an upstream. Rendered as “verified by this router” / ' +
    '“denied by this router” — never a bare “verified”, which is reserved for nothing in this schema ' +
    '(ADR-002). PENDING is where every endpoint starts and restarts: no live verdict yet, so it serves nothing.',
});
