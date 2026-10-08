import { graphql } from '../../generated';

/**
 * The evidence summary SUP-221 ruling 1 requires the admin section to render for
 * every registered endpoint — at registration and on every change.
 *
 * It rides along with the endpoint list rather than being fetched per drawer:
 * the ruling is that the operator *always* sees what a cloud-level admission let
 * in, and a summary one click away behind a second round trip is a summary a
 * tired operator does not look at.
 */
export const EXTERNAL_ENDPOINT_EVIDENCE_FIELDS = graphql(`
  fragment ExternalEndpointEvidenceFields on ExternalEndpointEvidence {
    snapshotId
    fetchedAt
    issuedAt
    evidenceDigest
    evidenceDigestHex
    certFingerprint
    certFingerprintHex
    quoteFormat
    containerImages
    workloads {
      kind
      name
      namespace
      containers
    }
    measurements {
      name
      value
    }
  }
`);

/**
 * Everything the list, the drawer and every mutation's response need for one
 * endpoint. The mutations all return an `ExternalEndpoint`, and one that came
 * back with fewer fields than the list renders would write a hole into the
 * Apollo cache.
 */
export const EXTERNAL_ENDPOINT_FIELDS = graphql(`
  fragment ExternalEndpointFields on ExternalEndpoint {
    id
    name
    baseUrl
    hostname
    enabled
    status
    lastCheckedAt
    lastStage
    lastReason
    measurementSeen
    measurementSource
    measurementInRegistry
    evidenceDigestSeen
    pinnedCertFingerprint
    apiKeyPrefix
    createdAt
    updatedAt
    models {
      id
      name
      upstreamModel
      contextLength
      capabilities
      pricing {
        promptPer1m
        completionPer1m
      }
    }
    latestEvidence {
      ...ExternalEndpointEvidenceFields
    }
    events {
      id
      at
      kind
      stage
      reason
      measurement
      evidenceDigest
      evidence {
        ...ExternalEndpointEvidenceFields
      }
    }
  }
`);

export const EXTERNAL_ENDPOINTS_QUERY = graphql(`
  query ExternalEndpoints {
    externalEndpoints {
      ...ExternalEndpointFields
    }
  }
`);

export const REGISTER_EXTERNAL_ENDPOINT = graphql(`
  mutation RegisterExternalEndpoint($input: RegisterExternalEndpointInput!) {
    registerExternalEndpoint(input: $input) {
      ...ExternalEndpointFields
    }
  }
`);

export const UPDATE_EXTERNAL_ENDPOINT = graphql(`
  mutation UpdateExternalEndpoint($id: ID!, $input: UpdateExternalEndpointInput!) {
    updateExternalEndpoint(id: $id, input: $input) {
      ...ExternalEndpointFields
    }
  }
`);

/**
 * What the register dialog polls while the router attests a freshly registered
 * upstream (SUP-249): status and the stage/reason of the last check, plus the
 * models the endpoint publishes *now* — `updateExternalEndpoint` replaces the
 * set, so the picker re-reads them before it writes rather than trusting a list
 * fetched minutes ago. The evidence summary arrives with the list once the dialog
 * hands over to the drawer.
 */
export const EXTERNAL_ENDPOINT_VERDICT_QUERY = graphql(`
  query ExternalEndpointVerdict($id: ID!) {
    externalEndpoint(id: $id) {
      id
      status
      lastCheckedAt
      lastStage
      lastReason
      measurementSeen
      pinnedCertFingerprint
      models {
        id
        name
        upstreamModel
        contextLength
        capabilities
        pricing {
          promptPer1m
          completionPer1m
        }
      }
    }
  }
`);

/** The upstream's own `GET /v1/models`, asked through the attested egress — only once it is verified. */
export const DISCOVER_EXTERNAL_MODELS = graphql(`
  query DiscoverExternalModels($id: ID!) {
    discoverExternalModels(id: $id) {
      upstreamModel
      name
      contextLength
      promptPer1mMicros
      completionPer1mMicros
      registeredAs
    }
  }
`);

export const SET_EXTERNAL_ENDPOINT_ENABLED = graphql(`
  mutation SetExternalEndpointEnabled($id: ID!, $input: SetExternalEndpointEnabledInput!) {
    setExternalEndpointEnabled(id: $id, input: $input) {
      ...ExternalEndpointFields
    }
  }
`);

export const ROTATE_EXTERNAL_ENDPOINT_KEY = graphql(`
  mutation RotateExternalEndpointKey($id: ID!, $input: RotateExternalEndpointKeyInput!) {
    rotateExternalEndpointKey(id: $id, input: $input) {
      ...ExternalEndpointFields
    }
  }
`);

export const TRUSTED_MEASUREMENTS_QUERY = graphql(`
  query TrustedMeasurements {
    trustedMeasurements {
      id
      measurement
      note
      addedByEmail
      addedAt
      admits
    }
  }
`);

export const ADD_TRUSTED_MEASUREMENT = graphql(`
  mutation AddTrustedMeasurement($input: AddTrustedMeasurementInput!) {
    addTrustedMeasurement(input: $input) {
      id
      measurement
      note
      addedByEmail
      addedAt
      admits
    }
  }
`);

export const REMOVE_TRUSTED_MEASUREMENT = graphql(`
  mutation RemoveTrustedMeasurement($id: ID!) {
    removeTrustedMeasurement(id: $id)
  }
`);
