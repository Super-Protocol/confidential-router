import { graphql } from '../../generated';

/**
 * Everything the evidence modal renders.
 *
 * `bundle` is deliberately absent: it is the whole published JSON, it is only
 * needed by the evidence export, and pulling it into every endpoint row of the
 * Overview would put kilobytes of JSON the screen never shows on the wire.
 * "Copy evidence JWS" copies `jws`, which is the signed form anyway.
 */
export const EVIDENCE_SNAPSHOT_FIELDS = graphql(`
  fragment EvidenceSnapshotFields on EvidenceSnapshot {
    id
    endpointId
    issuedAt
    fetchedAt
    quoteAgeSeconds
    quoteFormat
    evidenceDigest
    evidenceDigestHex
    certFingerprint
    certFingerprintHex
    containerImages
    measurements {
      name
      value
    }
    chain {
      subject
      issuer
      notAfter
      fingerprint
      fingerprintHex
      isRoot
    }
    jws
  }
`);

/**
 * An endpoint as the evidence badge and modal need it. Overview asks for it on
 * `endpoints`, Models on `model.endpoint` — the same fragment, so the same
 * modal opens with the same data from either screen.
 */
export const ENDPOINT_EVIDENCE_FIELDS = graphql(`
  fragment EndpointEvidenceFields on Endpoint {
    id
    name
    hostname
    tee
    evidenceState
    latestEvidence {
      ...EvidenceSnapshotFields
    }
  }
`);

/**
 * "Fetch fresh quote". A re-poll of what the platform publishes — it asks the
 * endpoint for its current bundle and stores what comes back. It is not a
 * verification, and it can legitimately answer `null` when the platform has
 * nothing published for that hostname.
 */
export const REFRESH_EVIDENCE = graphql(`
  mutation RefreshEvidence($endpointId: ID!) {
    refreshEvidence(endpointId: $endpointId) {
      ...EvidenceSnapshotFields
    }
  }
`);
