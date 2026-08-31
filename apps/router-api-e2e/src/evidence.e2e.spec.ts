/**
 * The evidence pipeline, from a real publisher over real TLS.
 *
 * The router does not verify anything and never reports a verdict (ADR-002) —
 * it *retrieves* what the platform publishes for its hostnames, and the console
 * renders that. The in-process suite feeds the poller a canned document; this
 * one makes it fetch from a live HTTPS endpoint whose certificate is minted by
 * a CA the process was told to trust, which is the only way to find out whether
 * the retrieval half works outside a stubbed `fetch`.
 *
 * The rotation cases are the same events the gatekeeper demo turns into denials,
 * seen from the other side: here they are just new publications the router
 * files under the endpoint.
 */
import { delay, type RouterStack, startRouterStack } from '@confidential-router/demo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The poller runs every 2s in the demo config; give it a few cycles. */
const PUBLICATION_TIMEOUT_MS = 30_000;

interface EndpointView {
  id: string;
  name: string;
  hostname: string;
  evidenceState: string;
  latestEvidence: {
    evidenceDigest: string;
    evidenceDigestHex: string;
    certFingerprint: string;
    containerImages: string[];
    issuedAt: string;
  } | null;
}

let stack: RouterStack;

beforeAll(async () => {
  stack = await startRouterStack();
});

afterAll(async () => {
  await stack?.stop();
});

async function endpoints(): Promise<EndpointView[]> {
  const data = await stack.session.graphql<{ endpoints: EndpointView[] }>(
    `query Endpoints($workspaceId: ID!) {
       endpoints(workspaceId: $workspaceId) {
         id name hostname evidenceState
         latestEvidence { evidenceDigest evidenceDigestHex certFingerprint containerImages issuedAt }
       }
     }`,
    { workspaceId: stack.session.workspaceId },
  );
  return data.endpoints;
}

/** Waits until the console reports the digest the host is publishing now. */
async function waitForPublishedDigest(expected: string): Promise<EndpointView> {
  const deadline = Date.now() + PUBLICATION_TIMEOUT_MS;
  let latest: EndpointView | undefined;
  for (;;) {
    latest = (await endpoints())[0];
    if (latest?.latestEvidence?.evidenceDigest === expected) {
      return latest;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the console still reports ${latest?.latestEvidence?.evidenceDigest ?? 'nothing'}, expected ${expected}`,
      );
    }
    await delay(500);
  }
}

describe('published evidence, retrieved over TLS', () => {
  it('files what the endpoint publishes under the endpoint that published it', async () => {
    const published = stack.evidenceHost.evidenceDigest();

    const endpoint = await waitForPublishedDigest(published);

    expect(endpoint.hostname).toBe(stack.evidenceHost.hostname);
    expect(endpoint.latestEvidence?.evidenceDigestHex).toMatch(/^[0-9a-f]{64}$/);
    expect(endpoint.latestEvidence?.certFingerprint).toMatch(/^sha256\//);
    expect(endpoint.latestEvidence?.containerImages.length).toBeGreaterThan(0);
  });

  it('records a redeployment as a new digest in the endpoint history', async () => {
    const before = stack.evidenceHost.evidenceDigest();
    const after = await stack.evidenceHost.rotateDeployment('router-api-e2e');
    expect(after).not.toBe(before);

    const endpoint = await waitForPublishedDigest(after);

    const history = await stack.session.graphql<{
      evidenceDigestHistory: { evidenceDigest: string; firstIssuedAt: string }[];
    }>(
      'query History($endpointId: ID!) { evidenceDigestHistory(endpointId: $endpointId) { evidenceDigest firstIssuedAt } }',
      { endpointId: endpoint.id },
    );
    const digests = history.evidenceDigestHistory.map((change) => change.evidenceDigest);
    expect(digests).toContain(before);
    expect(digests).toContain(after);
  });

  it('keeps the last publication when the publisher goes away, and says so', async () => {
    const published = stack.evidenceHost.evidenceDigest();
    await waitForPublishedDigest(published);

    stack.evidenceHost.stopPublishing();
    try {
      // Long enough for several failed polls.
      await delay(6_000);
      const [endpoint] = await endpoints();

      // The router reports what it last retrieved. It is not a verdict, and a
      // publisher that stopped answering does not retract what it published.
      expect(endpoint.latestEvidence?.evidenceDigest).toBe(published);
    } finally {
      stack.evidenceHost.resumePublishing();
    }
  });

  it('attributes a generation to the publication that was current when it was served', async () => {
    const published = stack.evidenceHost.evidenceDigest();
    await waitForPublishedDigest(published);

    await fetch(`${stack.router.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${stack.credential.secret}` },
      body: JSON.stringify({
        model: 'meta/llama-3.3-70b-instruct:tdx',
        messages: [{ role: 'user', content: 'Was this covered?' }],
      }),
    });

    const covered = await waitForCoveredGeneration(published);
    expect(covered).toBe(true);
  });
});

/** Polls the console until a generation carries the digest that was current. */
async function waitForCoveredGeneration(expected: string): Promise<boolean> {
  const deadline = Date.now() + PUBLICATION_TIMEOUT_MS;
  for (;;) {
    const data = await stack.session.graphql<{
      generations: { edges: { node: { evidenceDigest: string | null } }[] };
    }>(
      'query Covered($workspaceId: ID!) { generations(workspaceId: $workspaceId, first: 20) ' +
        '{ edges { node { evidenceDigest } } } }',
      { workspaceId: stack.session.workspaceId },
    );
    if (data.generations.edges.some((edge) => edge.node.evidenceDigest === expected)) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await delay(500);
  }
}
