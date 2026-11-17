import { graphql } from '../../generated';

/**
 * An external model's upstream, as the catalogue hands it over.
 *
 * `name` is in here for one reason that is easy to mistake for incidental: it is
 * the key of this router's evidence relay, `GET /v1/evidence/{endpoint}`, which
 * is the only way a browser can read another deployment's published bundle at
 * all — the upstream's own gateway sends no `Access-Control-Allow-Origin`
 * (SUP-191, ADR-008 §7). Without it the inspect panel would have nothing to
 * verify.
 *
 * The whole field is null for an anonymous reader (SUP-221 ruling 3), so every
 * consumer has to handle its absence rather than assume a signed-in viewer.
 */
export const EXTERNAL_UPSTREAM_FIELDS = graphql(`
  fragment ExternalUpstreamFields on ExternalUpstream {
    id
    name
    hostname
    status
    lastCheckedAt
    measurementSeen
    evidenceDigestSeen
    evidenceDigestSeenHex
  }
`);
