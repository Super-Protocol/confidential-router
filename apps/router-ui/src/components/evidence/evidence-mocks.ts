import type { MockLink } from '@apollo/client/testing';
import { evidenceSnapshot, publishedEndpoint } from '../../test-fixtures';
import { DEPLOYMENT_DIGEST_QUERY } from './deployment-digest';

/** The digest the SUP-524 walk pinned, in the spelling the gatekeeper prints. */
export const DEPLOYMENT_DIGEST_HEX = '3509d9f922d02ed3ec3faf50bbb26399661e93f8e44dbda83a4f84b3d0100f16';

/**
 * What `DeploymentDigest` asks for, answered.
 *
 * It sits in `renderWithSession`'s defaults next to `feedbackOfferMock()` and
 * for the same reason: Overview and the API Keys page both mount the block, so
 * a suite about a key or a ledger row would otherwise have to stub an operation
 * it is not testing — and until it did, Apollo filled its output with "no more
 * mocked responses" for a query the suite never asked about.
 *
 * Pass `null` for the deployment that cannot name its own endpoint.
 */
export function deploymentDigestMock(
  endpoint: Record<string, unknown> | null = {
    ...publishedEndpoint({
      hostname: 'api.router.superprotocol.com',
      latestEvidence: evidenceSnapshot({ evidenceDigestHex: DEPLOYMENT_DIGEST_HEX, tee: 'Intel TDX (Azure)' }),
    }),
  },
): MockLink.MockedResponse {
  return {
    request: { query: DEPLOYMENT_DIGEST_QUERY },
    result: { data: { routerEndpoint: endpoint } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}
