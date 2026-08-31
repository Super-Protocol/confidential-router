import { graphql } from '../../generated';

/**
 * The Gatekeeper screen's only query — and the only one it could have.
 *
 * The router never learns that a gatekeeper verified anything (ADR-002), so
 * there is no instance list, no registration and no status to read: the screen
 * describes a published artefact and nothing else.
 */
export const GATEKEEPER_RELEASE_QUERY = graphql(`
  query GatekeeperRelease {
    gatekeeperRelease {
      version
      notesUrl
      checksumsUrl
      publishedAt
      fetchedAt
      stale
      downloads {
        os
        arch
        name
        url
        sizeBytes
      }
    }
  }
`);
