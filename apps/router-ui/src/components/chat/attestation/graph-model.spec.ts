import { describe, expect, it } from 'vitest';
import { DECLARED_IMAGES, SIGNED_SNAPSHOT } from '../../../test-fixtures';
import {
  buildDeploymentGraph,
  type DeploymentGraph,
  type ImageVerdict,
  parseImageReference,
  verdictFor,
} from './graph-model';

/**
 * The graph is the one place this feature makes a claim a reader cannot check by
 * eye: a green container means "the digest in the signed evidence is a digest the
 * operator declared", and nothing on screen distinguishes that from a green box
 * drawn because the code never looked. So the cases below are mostly about which
 * of the five verdicts comes back, against the shape the live platform actually
 * signs (`SIGNED_SNAPSHOT` in `test-fixtures.ts`).
 */

function graph(overrides: Partial<Parameters<typeof buildDeploymentGraph>[0]> = {}): DeploymentGraph {
  return buildDeploymentGraph({ snapshot: SIGNED_SNAPSHOT, declaredImages: DECLARED_IMAGES, ...overrides });
}

function node(result: DeploymentGraph, id: string) {
  const found = result.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no node ${id} in ${result.nodes.map((n) => n.id).join(', ')}`);
  return found;
}

function verdictOf(result: DeploymentGraph, containerName: string): ImageVerdict | null {
  return result.containers.find((container) => container.name === containerName)?.verdict ?? null;
}

/** A copy of the signed snapshot with one surgical change. */
function doctored(mutate: (snapshot: { resources: Record<string, unknown>[] }) => void): unknown {
  const copy = structuredClone(SIGNED_SNAPSHOT) as { resources: Record<string, unknown>[] };
  mutate(copy);
  return copy;
}

/** The container image of the `router-api` Deployment, wherever it sits. */
function routerApiImage(snapshot: { resources: Record<string, unknown>[] }): { image: string } {
  const deployment = snapshot.resources.find(
    (resource) =>
      resource.kind === 'Deployment' && (resource.metadata as { name: string } | undefined)?.name === 'router-api',
  ) as {
    spec: { template: { spec: { containers: { image: string }[] } } };
  };
  return deployment.spec.template.spec.containers[0] as { image: string };
}

describe('the graph the live platform’s snapshot produces', () => {
  it('draws ingress hosts, services, workloads and containers, in that order', () => {
    const result = graph();

    expect(result.problem).toBeNull();
    expect(node(result, 'host:llama-33-70b.tee.swarm.cloud').layer).toBe(0);
    expect(node(result, 'service:router-api').layer).toBe(1);
    expect(node(result, 'workload:Deployment/router-api').layer).toBe(2);
    expect(node(result, 'container:Deployment/router-api/router-api').layer).toBe(3);
  });

  it('routes a host to the service its ingress rule names', () => {
    const result = graph();

    expect(result.edges).toContainEqual({
      id: 'host:llama-33-70b.tee.swarm.cloud->service:router-api',
      source: 'host:llama-33-70b.tee.swarm.cloud',
      target: 'service:router-api',
      relation: 'routes-to',
    });
  });

  it('joins a service to the workload its selector picks out, and to no other', () => {
    const result = graph();
    const fromRouterApi = result.edges.filter((edge) => edge.source === 'service:router-api');

    expect(fromRouterApi).toEqual([
      {
        id: 'service:router-api->workload:Deployment/router-api',
        source: 'service:router-api',
        target: 'workload:Deployment/router-api',
        relation: 'selects',
      },
    ]);
  });

  it('selects a StatefulSet the same way it selects a Deployment', () => {
    // The two workload kinds the issue names. A graph that drew only Deployments
    // would silently omit a whole workload of the attested document.
    const result = graph();

    expect(result.edges).toContainEqual({
      id: 'service:router-ui->workload:StatefulSet/router-ui',
      source: 'service:router-ui',
      target: 'workload:StatefulSet/router-ui',
      relation: 'selects',
    });
  });

  it('carries init containers, labelled as such', () => {
    // An init container runs on the same node with the same access to the
    // workload's secrets, so leaving it out would understate what the enclave runs.
    const result = graph();
    const migrate = node(result, 'container:Deployment/router-api/migrate');

    expect(migrate.detail).toBe('init container');
    expect(migrate.verdict).toEqual({ status: 'declared', declaredDigest: DECLARED_IMAGES[0]?.digest });
  });

  it('hands each node the object it was drawn from, for the raw-fields drawer', () => {
    const result = graph();

    expect(node(result, 'workload:Deployment/litellm').raw).toBe(
      SIGNED_SNAPSHOT.resources.find(
        (resource) => resource.kind === 'Deployment' && resource.metadata?.name === 'litellm',
      ),
    );
  });

  it('names the kinds it did not draw rather than dropping them silently', () => {
    const result = graph();

    expect(result.undrawn).toEqual([
      { kind: 'ConfigMap', count: 1 },
      { kind: 'Secret', count: 1 },
    ]);
    expect(result.resourceCount).toBe(SIGNED_SNAPSHOT.resources.length);
  });

  it('lists the TLS-only host even though no rule routes it', () => {
    /*
     * `console.tee.swarm.cloud` has a rule here, so the interesting case is the
     * one where a host appears under `spec.tls` alone: it is a hostname the
     * deployment holds a certificate for, and a reader comparing the graph with
     * their URL bar has to be able to find it.
     */
    const result = buildDeploymentGraph({
      snapshot: doctored((snapshot) => {
        const ingress = snapshot.resources.find((resource) => resource.kind === 'Ingress') as {
          spec: { tls: { hosts: string[] }[] };
        };
        ingress.spec.tls[0]?.hosts.push('status.tee.swarm.cloud');
      }),
      declaredImages: DECLARED_IMAGES,
    });

    expect(node(result, 'host:status.tee.swarm.cloud').detail).toBe('Ingress');
  });
});

describe('matching a container digest against the operator’s allow-list', () => {
  it('passes an image whose name and digest are both declared', () => {
    expect(verdictOf(graph(), 'litellm')).toEqual({ status: 'declared', declaredDigest: DECLARED_IMAGES[1]?.digest });
  });

  it('flags an image the allow-list does not mention at all', () => {
    // The doctored snapshot: a signed document that deploys something nobody
    // declared. It is the case the panel paints red, and the reason the comparison
    // is made against config rather than against the snapshot's own digests.
    const result = buildDeploymentGraph({
      snapshot: doctored((snapshot) => {
        routerApiImage(snapshot).image =
          'docker.io/library/nginx@sha256:4444444444444444444444444444444444444444444444444444444444444444';
      }),
      declaredImages: DECLARED_IMAGES,
    });

    expect(verdictOf(result, 'router-api')).toEqual({ status: 'not-declared' });
    // The init container of the same workload still declares cleanly: one
    // undeclared image must not condemn its neighbours.
    expect(verdictOf(result, 'migrate')).toEqual({ status: 'declared', declaredDigest: DECLARED_IMAGES[0]?.digest });
  });

  it('tells a different build of a declared component apart from an unknown one', () => {
    /*
     * The loudest case, and the reason it is not folded into `not-declared`: the
     * operator demonstrably knows this component, so a digest they did not declare
     * is not a gap in the list — it is a deployment of something else under a name
     * the reader recognises.
     */
    const result = buildDeploymentGraph({
      snapshot: doctored((snapshot) => {
        routerApiImage(snapshot).image = `ghcr.io/super-protocol/router-api@sha256:${'9'.repeat(64)}`;
      }),
      declaredImages: DECLARED_IMAGES,
    });

    expect(verdictOf(result, 'router-api')).toEqual({
      status: 'digest-mismatch',
      declaredDigests: [DECLARED_IMAGES[0]?.digest],
    });
  });

  it('does not claim a pass for an image the evidence did not pin', () => {
    const result = buildDeploymentGraph({
      snapshot: doctored((snapshot) => {
        routerApiImage(snapshot).image = 'ghcr.io/super-protocol/router-api:1.4.0';
      }),
      declaredImages: DECLARED_IMAGES,
    });

    expect(verdictOf(result, 'router-api')).toEqual({ status: 'not-pinned' });
  });

  it('does not claim a pass when the endpoint declares no allow-list', () => {
    // The state most deployments are in today, and the one an over-eager green
    // would be most misleading in.
    const result = buildDeploymentGraph({ snapshot: SIGNED_SNAPSHOT, declaredImages: null });

    expect(verdictOf(result, 'router-api')).toEqual({ status: 'no-allow-list' });
  });

  it('treats an empty allow-list as "declared to run nothing", not as "nothing declared"', () => {
    const result = buildDeploymentGraph({ snapshot: SIGNED_SNAPSHOT, declaredImages: [] });

    expect(verdictOf(result, 'router-api')).toEqual({ status: 'not-declared' });
  });
});

describe('reading an image reference', () => {
  it('splits repository, tag and digest', () => {
    expect(parseImageReference(`ghcr.io/sp/api:1.2@sha256:${'a'.repeat(64)}`)).toEqual({
      raw: `ghcr.io/sp/api:1.2@sha256:${'a'.repeat(64)}`,
      name: 'ghcr.io/sp/api',
      tag: '1.2',
      digest: `sha256:${'a'.repeat(64)}`,
    });
  });

  it('does not mistake a registry port for a tag', () => {
    // `registry.internal:5000/router/api` has a colon that is not a tag
    // separator; treating it as one would compare the wrong name and report a
    // declared image as undeclared.
    expect(parseImageReference('registry.internal:5000/router/api')).toMatchObject({
      name: 'registry.internal:5000/router/api',
      tag: null,
      digest: null,
    });
  });

  it('refuses a digest that is not a sha256 hex', () => {
    // `containerImages` in the router's own snapshot carries truncated digests in
    // places; a truncation must read as "not pinned", never as a digest to match.
    expect(parseImageReference('vllm-tdx@sha256:6b1f9c04')?.digest).toBeNull();
  });

  it('has no verdict for a container with no image at all', () => {
    expect(verdictFor(null, DECLARED_IMAGES)).toBeNull();
  });
});

describe('snapshots that are not the live shape', () => {
  it('reads the flat resource shape the conformance vectors publish', () => {
    // `{ kind, name, namespace, containers }` — what `tools/mock-evidence-host`
    // serves. Reading only the Kubernetes shape is the mirror of the SUP-157 bug.
    const result = buildDeploymentGraph({
      snapshot: {
        version: 2,
        resources: [
          {
            kind: 'Deployment',
            name: 'router-api',
            namespace: 'confidential-router',
            containers: [
              { name: 'router-api', image: `ghcr.io/super-protocol/router-api@${DECLARED_IMAGES[0]?.digest}` },
            ],
          },
        ],
      },
      declaredImages: DECLARED_IMAGES,
    });

    expect(node(result, 'workload:Deployment/router-api').namespace).toBe('confidential-router');
    expect(verdictOf(result, 'router-api')).toEqual({ status: 'declared', declaredDigest: DECLARED_IMAGES[0]?.digest });
  });

  it('reads the grouped shape the Chrome extension renders', () => {
    const result = buildDeploymentGraph({
      snapshot: {
        namespace: 'confidential-router',
        ingresses: [
          {
            metadata: { name: 'router', namespace: 'confidential-router' },
            spec: {
              rules: [
                { host: 'api.example.test', http: { paths: [{ backend: { service: { name: 'router-api' } } }] } },
              ],
            },
          },
        ],
        services: [
          {
            metadata: { name: 'router-api', namespace: 'confidential-router' },
            spec: { selector: { app: 'router-api' } },
          },
        ],
        deployments: [],
        statefulSets: [],
        daemonSets: [],
        pods: [],
        configMaps: [],
        secrets: [],
      },
      declaredImages: DECLARED_IMAGES,
    });

    expect(result.problem).toBeNull();
    expect(result.edges).toContainEqual({
      id: 'host:api.example.test->service:router-api',
      source: 'host:api.example.test',
      target: 'service:router-api',
      relation: 'routes-to',
    });
  });

  it('says there is nothing to draw when the producer signed a digest without the snapshot', () => {
    const result = buildDeploymentGraph({ snapshot: undefined, declaredImages: DECLARED_IMAGES });

    expect(result.nodes).toEqual([]);
    expect(result.problem).toMatch(/not the deployment snapshot behind it/);
  });

  it('refuses to guess at a document that is not a snapshot', () => {
    const result = buildDeploymentGraph({ snapshot: { hello: 'world' }, declaredImages: DECLARED_IMAGES });

    expect(result.nodes).toEqual([]);
    expect(result.problem).toMatch(/not in a shape this panel can read/);
  });

  it('drops an edge to a service the document does not declare, rather than drawing a line into nothing', () => {
    const result = buildDeploymentGraph({
      snapshot: doctored((snapshot) => {
        snapshot.resources = snapshot.resources.filter(
          (resource) =>
            !(resource.kind === 'Service' && (resource.metadata as { name: string } | undefined)?.name === 'router-ui'),
        );
      }),
      declaredImages: DECLARED_IMAGES,
    });

    expect(result.edges.some((edge) => edge.target === 'service:router-ui')).toBe(false);
    // The ingress host it was reached through is still drawn: the backend name is
    // in that node's raw fields either way.
    expect(node(result, 'host:console.tee.swarm.cloud')).toBeTruthy();
  });
});
