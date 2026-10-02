/**
 * The deployment graph, derived from the signed evidence and nothing else.
 *
 * This module is the whole of the graph's logic, deliberately separated from the
 * component that draws it: the interesting claims — which nodes exist, what
 * connects them, and whether a container's digest is one the operator declared —
 * are claims about a document, not about a canvas, and they are worth holding to
 * tests that cannot be satisfied by a convincing-looking picture.
 *
 * ## It is drawn from the attested document, not from an API
 *
 * The input is `payload.evidence` of the JWS the page has already verified
 * (`verification/evidence-gate.ts` carries it through as `GateEvidence.snapshot`).
 * There is no second fetch and no live cluster read anywhere in this feature,
 * which is the point of it: the graph *is* the signed document, so a reader who
 * trusts the signature has to accept the picture, and a reader who does not gets
 * no picture at all (`runEvidenceGate` returns no evidence when a check fails).
 *
 * ## Three snapshot shapes
 *
 * A producer may publish any of them, and the one the live platform publishes is
 * the first:
 *
 *  1. **Canonical, Kubernetes documents** — `{ version: 2, resources: [...] }`
 *     where each resource is a full object with `metadata`/`spec`. This is what
 *     swarm-cloud's `buildCanonicalSnapshot` emits, so it is what
 *     `/.well-known/swarm-evidence` serves today.
 *  2. **Canonical, flat** — the same envelope, but a resource is
 *     `{ kind, name, namespace, containers }`. The conformance vectors and
 *     `tools/mock-evidence-host` use it.
 *  3. **Grouped** — `{ namespace, ingresses, services, deployments, … }`, the
 *     shape the Chrome extension's `DeploymentFlowGraph` reads.
 *
 * All three are normalised to one list of resources before anything else looks
 * at them. Reading only the shape in front of us is exactly the mistake SUP-157
 * fixed in the evidence modal, where the flat reader left every real deployment's
 * image list empty.
 *
 * ## What it refuses to do
 *
 * Invent. A resource whose shape is not recognised is *counted and named* rather
 * than dropped quietly ({@link DeploymentGraph.undrawn}), because a graph that
 * silently omits part of a signed document is a worse lie than one that says
 * "there were four Secrets in here and I did not draw them".
 */

/** The canonical snapshot envelope, as the bundle schema describes it. */
interface SnapshotEnvelope {
  version?: unknown;
  resources?: unknown;
}

/** The grouped shape, keyed by the plural of each kind. */
const GROUPED_KEYS = {
  ingresses: 'Ingress',
  services: 'Service',
  deployments: 'Deployment',
  statefulSets: 'StatefulSet',
  daemonSets: 'DaemonSet',
  pods: 'Pod',
  configMaps: 'ConfigMap',
  secrets: 'Secret',
} as const satisfies Record<string, string>;

/** The workload kinds the graph draws as a layer of their own. */
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob', 'Pod']);

export type NodeKind = 'host' | 'service' | 'workload' | 'container';

/** Why an edge exists, which is also how it is drawn and described. */
export type EdgeRelation = 'routes-to' | 'selects' | 'runs';

/** A container image reference, split into the parts a reader compares. */
export interface ImageReference {
  /** The whole reference as the evidence spells it. */
  raw: string;
  /** Repository without tag or digest, e.g. `ghcr.io/super-protocol/router-api`. */
  name: string;
  /** `sha256:<64 hex>`, or null when the reference is not digest-pinned. */
  digest: string | null;
  tag: string | null;
}

/**
 * Whether a container's image is one the operator declared.
 *
 * Four answers, and the distinction between the last three is the whole value of
 * the row:
 *
 *  - `declared` — name and digest both appear in the allow-list. Green.
 *  - `digest-mismatch` — the component is declared, but this is a *different
 *    build of it*. The loudest case: something was deployed that the declaration
 *    does not cover, and the declaration proves the operator knows the
 *    component, so this is not a gap in the list.
 *  - `not-declared` — the image is not in the list at all.
 *  - `not-pinned` — the evidence carries a tag rather than a digest, so there is
 *    nothing to compare. Not a pass and not a failure: a tag is mutable, so it
 *    cannot be matched against a pin even in principle.
 *  - `no-allow-list` — the endpoint declares none. Also not a pass: an unchecked
 *    image drawn green would be the single most misleading thing on the panel.
 */
export type ImageVerdict =
  | { status: 'declared'; declaredDigest: string }
  | { status: 'digest-mismatch'; declaredDigests: string[] }
  | { status: 'not-declared' }
  | { status: 'not-pinned' }
  | { status: 'no-allow-list' };

/** One `{ name, digest }` pair of the operator's allow-list. */
export interface DeclaredImage {
  name: string;
  digest: string;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Primary label: a hostname, a resource name, a container name. */
  name: string;
  /** One short secondary line — the Kubernetes kind, the service type, the tag. */
  detail: string | null;
  namespace: string | null;
  /** Column in the layered layout; 0 is the ingress hosts. */
  layer: number;
  /** Set on container nodes only. */
  image: ImageReference | null;
  verdict: ImageVerdict | null;
  /**
   * The object out of the signed document this node was drawn from — what the
   * raw-fields drawer shows. A reference into the snapshot, never a reshaped
   * copy, so what the drawer prints is what was signed.
   */
  raw: unknown;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: EdgeRelation;
}

/** A kind the reader saw in the snapshot and did not draw, with how many. */
export interface UndrawnKind {
  kind: string;
  count: number;
}

export interface DeploymentGraph {
  nodes: PositionedNode[];
  edges: GraphEdge[];
  /** Namespaces the drawn resources belong to, sorted. */
  namespaces: string[];
  /** Every container found, in node order — the measurements panel's image list. */
  containers: PositionedNode[];
  /** How many resources the snapshot carried in total. */
  resourceCount: number;
  /** Kinds present in the document but outside the four layers, named not hidden. */
  undrawn: UndrawnKind[];
  /**
   * Why there is no graph, when there is none. Null on success — including the
   * success where a valid snapshot simply has no routable resources in it.
   */
  problem: string | null;
}

const EMPTY: DeploymentGraph = {
  nodes: [],
  edges: [],
  namespaces: [],
  containers: [],
  resourceCount: 0,
  undrawn: [],
  problem: null,
};

export interface BuildGraphOptions {
  /** The verified `payload.evidence`. */
  snapshot: unknown;
  /** The operator's allow-list, or null when the endpoint declares none. */
  declaredImages: readonly DeclaredImage[] | null;
}

export function buildDeploymentGraph({ snapshot, declaredImages }: BuildGraphOptions): DeploymentGraph {
  const resources = resourcesOf(snapshot);
  if (!resources) {
    return {
      ...EMPTY,
      problem:
        snapshot === undefined || snapshot === null
          ? 'The signed evidence carries a digest but not the deployment snapshot behind it, so there is nothing to draw. The digest is still the value to pin, and Gatekeeper reads the same bundle.'
          : 'The signed deployment snapshot is not in a shape this panel can read, so no graph is drawn from it. The raw document is still what the digest covers.',
    };
  }

  const byKind = groupByKind(resources);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const services = byKind.get('Service') ?? [];
  const workloads = [...WORKLOAD_KINDS].flatMap((kind) => (byKind.get(kind) ?? []).map((raw) => ({ kind, raw })));

  /* Layer 0 — the hostnames the deployment answers on. */
  for (const ingress of byKind.get('Ingress') ?? []) {
    for (const host of hostsOf(ingress)) {
      const id = `host:${host.name}`;
      if (!nodes.some((node) => node.id === id)) {
        nodes.push({
          id,
          kind: 'host',
          name: host.name,
          detail: host.anyHost ? 'any host' : 'Ingress',
          namespace: namespaceOf(ingress),
          layer: 0,
          image: null,
          verdict: null,
          raw: ingress,
        });
      }
      for (const service of host.services) {
        pushEdge(edges, { source: id, target: `service:${service}`, relation: 'routes-to' });
      }
    }
  }

  /* Layer 1 — the services those hosts route to. */
  for (const service of services) {
    const name = nameOf(service);
    if (!name) continue;
    nodes.push({
      id: `service:${name}`,
      kind: 'service',
      name,
      detail: stringAt(service, ['spec', 'type']) ?? 'ClusterIP',
      namespace: namespaceOf(service),
      layer: 1,
      image: null,
      verdict: null,
      raw: service,
    });
  }

  /* Layer 2 — the workloads a service's selector picks out. */
  for (const workload of workloads) {
    const name = nameOf(workload.raw);
    if (!name) continue;
    const id = `workload:${workload.kind}/${name}`;
    nodes.push({
      id,
      kind: 'workload',
      name,
      detail: workload.kind,
      namespace: namespaceOf(workload.raw),
      layer: 2,
      image: null,
      verdict: null,
      raw: workload.raw,
    });

    const labels = podLabelsOf(workload.raw);
    for (const service of services) {
      const serviceName = nameOf(service);
      if (!serviceName) continue;
      if (selects(recordAt(service, ['spec', 'selector']), labels)) {
        pushEdge(edges, { source: `service:${serviceName}`, target: id, relation: 'selects' });
      }
    }

    /* Layer 3 — the containers, each with its digest and its verdict. */
    for (const container of containersOf(workload.raw)) {
      const image = parseImageReference(container.image);
      nodes.push({
        id: `container:${workload.kind}/${name}/${container.name}`,
        kind: 'container',
        name: container.name,
        detail: container.init ? 'init container' : (image?.tag ?? null),
        namespace: namespaceOf(workload.raw),
        layer: 3,
        image,
        verdict: verdictFor(image, declaredImages),
        raw: container.raw,
      });
      pushEdge(edges, {
        source: id,
        target: `container:${workload.kind}/${name}/${container.name}`,
        relation: 'runs',
      });
    }
  }

  // An edge to a service no resource in the document declares would draw a line
  // into nothing. Dropping it is not hiding anything: the ingress object itself
  // is a node, and its raw fields — backend name included — are in its drawer.
  const present = new Set(nodes.map((node) => node.id));
  const drawn = edges.filter((edge) => present.has(edge.source) && present.has(edge.target));

  const undrawn = [...byKind.entries()]
    .filter(([kind]) => kind !== 'Ingress' && kind !== 'Service' && !WORKLOAD_KINDS.has(kind))
    .map(([kind, items]) => ({ kind, count: items.length }))
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));

  const laidOut = positioned(nodes);
  return {
    nodes: laidOut,
    edges: drawn,
    namespaces: [...new Set(laidOut.flatMap((node) => (node.namespace ? [node.namespace] : [])))].sort(),
    containers: laidOut.filter((node) => node.kind === 'container'),
    resourceCount: resources.length,
    undrawn,
    problem: null,
  };
}

/**
 * Normalises the three published shapes into one list.
 *
 * Returns null — rather than an empty list — when the value is not a snapshot at
 * all, because "no resources" and "not a snapshot" are different things the panel
 * says differently.
 */
function resourcesOf(snapshot: unknown): unknown[] | null {
  if (!isRecord(snapshot)) return null;

  const envelope = snapshot as SnapshotEnvelope;
  if (Array.isArray(envelope.resources)) {
    return envelope.resources;
  }

  // The grouped shape. Accepted when at least one of its keys is an array, so a
  // record that merely happens to lack `resources` is still rejected.
  const grouped = Object.entries(GROUPED_KEYS).flatMap(([key, kind]) => {
    const items = (snapshot as Record<string, unknown>)[key];
    return Array.isArray(items) ? items.map((item) => stampKind(item, kind)) : [];
  });
  const hasGroup = Object.keys(GROUPED_KEYS).some((key) => Array.isArray((snapshot as Record<string, unknown>)[key]));
  return hasGroup ? grouped : null;
}

/** The grouped shape's items carry no `kind`, so the key it came under supplies one. */
function stampKind(item: unknown, kind: string): unknown {
  if (!isRecord(item)) return item;
  return typeof item.kind === 'string' && item.kind.length > 0 ? item : { ...item, kind };
}

function groupByKind(resources: readonly unknown[]): Map<string, unknown[]> {
  const byKind = new Map<string, unknown[]>();
  for (const resource of resources) {
    const kind = isRecord(resource) && typeof resource.kind === 'string' && resource.kind ? resource.kind : 'unknown';
    const bucket = byKind.get(kind);
    if (bucket) bucket.push(resource);
    else byKind.set(kind, [resource]);
  }
  return byKind;
}

interface IngressHost {
  name: string;
  /** True for a rule with no `host`: it answers on whatever reaches the ingress. */
  anyHost: boolean;
  /** Backend service names reachable under this host. */
  services: string[];
}

/**
 * The hostnames one Ingress answers on, with the services each routes to.
 *
 * `spec.tls[].hosts` is read as well as `spec.rules[].host`: a host listed only
 * under TLS is a hostname the deployment holds a certificate for, which a reader
 * comparing the graph with the address in their URL bar has to be able to find.
 * It contributes no edges of its own — a rule is what routes — so it appears as a
 * host node with the ingress's default backend, if any.
 */
function hostsOf(ingress: unknown): IngressHost[] {
  const rules = arrayAt(ingress, ['spec', 'rules']);
  const defaultBackend = stringAt(ingress, ['spec', 'defaultBackend', 'service', 'name']);
  const hosts = new Map<string, IngressHost>();

  const upsert = (name: string, anyHost: boolean): IngressHost => {
    const existing = hosts.get(name);
    if (existing) return existing;
    const created: IngressHost = { name, anyHost, services: defaultBackend ? [defaultBackend] : [] };
    hosts.set(name, created);
    return created;
  };

  for (const rule of rules) {
    const host = stringAt(rule, ['host']);
    const entry = upsert(host ?? '*', host === null);
    for (const path of arrayAt(rule, ['http', 'paths'])) {
      const service = stringAt(path, ['backend', 'service', 'name']);
      if (service && !entry.services.includes(service)) entry.services.push(service);
    }
  }

  for (const host of arrayAt(ingress, ['spec', 'tls']).flatMap((tls) => arrayAt(tls, ['hosts']))) {
    if (typeof host === 'string' && host.length > 0) upsert(host, false);
  }

  // An ingress with neither rules nor TLS hosts still answers on something; `*`
  // keeps its default backend's edge rather than dropping the object entirely.
  if (hosts.size === 0 && defaultBackend) upsert('*', true);

  return [...hosts.values()];
}

interface GraphContainer {
  name: string;
  image: string | null;
  init: boolean;
  raw: unknown;
}

/**
 * The containers one workload runs.
 *
 * Both shapes a resource may keep them in — the controller's pod template, and
 * the flat `containers` the conformance vectors use — plus the extra level a
 * CronJob adds. The list is enumerated rather than searched recursively, the same
 * reasoning as `podSpecsOf` in `router-api`'s bundle parser: a blind walk for
 * anything named `containers` starts reporting whatever a future resource happens
 * to nest under that name.
 *
 * `initContainers` are included and labelled. An init container runs on the same
 * node with the same access to the workload's secrets, so a reader comparing what
 * the enclave runs has to see it.
 */
function containersOf(resource: unknown): GraphContainer[] {
  const specs = [
    resource,
    recordAt(resource, ['spec']),
    recordAt(resource, ['spec', 'template', 'spec']),
    recordAt(resource, ['spec', 'jobTemplate', 'spec', 'template', 'spec']),
  ];

  const found: GraphContainer[] = [];
  for (const spec of specs) {
    for (const [key, init] of [
      ['containers', false],
      ['initContainers', true],
    ] as const) {
      for (const container of arrayAt(spec, [key])) {
        if (!isRecord(container)) continue;
        const name = typeof container.name === 'string' && container.name ? container.name : null;
        const image = typeof container.image === 'string' && container.image ? container.image : null;
        if (!name && !image) continue;
        found.push({ name: name ?? (image as string), image, init, raw: container });
      }
    }
  }
  return found;
}

/**
 * Splits an image reference into repository, tag and digest.
 *
 * The tag is stripped only when its colon comes after the last `/`, because a
 * registry may carry a port — `registry.internal:5000/router/api` has a colon
 * that is not a tag separator. Returns null for an absent reference, which a
 * container may legitimately have in a snapshot that stripped it.
 */
export function parseImageReference(reference: string | null): ImageReference | null {
  if (!reference) return null;

  const [beforeDigest, digest] = splitOnce(reference, '@');
  const slash = beforeDigest.lastIndexOf('/');
  const colon = beforeDigest.lastIndexOf(':');
  const hasTag = colon > slash;

  return {
    raw: reference,
    name: hasTag ? beforeDigest.slice(0, colon) : beforeDigest,
    digest: digest && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null,
    tag: hasTag ? beforeDigest.slice(colon + 1) : null,
  };
}

function splitOnce(value: string, separator: string): [string, string | null] {
  const at = value.indexOf(separator);
  return at === -1 ? [value, null] : [value.slice(0, at), value.slice(at + separator.length)];
}

export function verdictFor(
  image: ImageReference | null,
  declared: readonly DeclaredImage[] | null,
): ImageVerdict | null {
  if (!image) return null;
  if (declared === null) return { status: 'no-allow-list' };
  if (!image.digest) return { status: 'not-pinned' };

  const sameName = declared.filter((entry) => entry.name === image.name);
  const exact = sameName.find((entry) => entry.digest === image.digest);
  if (exact) return { status: 'declared', declaredDigest: exact.digest };
  if (sameName.length > 0) {
    return { status: 'digest-mismatch', declaredDigests: sameName.map((entry) => entry.digest) };
  }
  return { status: 'not-declared' };
}

/** True when `selector` is non-empty and every pair of it appears in `labels`. */
function selects(selector: Record<string, unknown> | null, labels: Record<string, unknown> | null): boolean {
  if (!selector || !labels) return false;
  const pairs = Object.entries(selector);
  if (pairs.length === 0) return false;
  return pairs.every(([key, value]) => labels[key] === value);
}

/**
 * The labels a service's selector would match.
 *
 * The pod template's own labels first, because those are what a Service actually
 * selects on; `spec.selector.matchLabels` is the fallback for a snapshot whose
 * canonicalisation dropped the template metadata. A Pod carries them directly.
 */
function podLabelsOf(resource: unknown): Record<string, unknown> | null {
  return (
    recordAt(resource, ['spec', 'template', 'metadata', 'labels']) ??
    recordAt(resource, ['spec', 'selector', 'matchLabels']) ??
    recordAt(resource, ['metadata', 'labels'])
  );
}

function nameOf(resource: unknown): string | null {
  return stringAt(resource, ['metadata', 'name']) ?? stringAt(resource, ['name']);
}

function namespaceOf(resource: unknown): string | null {
  return stringAt(resource, ['metadata', 'namespace']) ?? stringAt(resource, ['namespace']);
}

function pushEdge(edges: GraphEdge[], edge: Omit<GraphEdge, 'id'>): void {
  const id = `${edge.source}->${edge.target}`;
  if (!edges.some((existing) => existing.id === id)) edges.push({ id, ...edge });
}

/** Column width and row pitch of the layered layout, in react-flow units. */
const COLUMN_WIDTH = 300;
const ROW_HEIGHT = 96;

export interface PositionedNode extends GraphNode {
  position: { x: number; y: number };
}

/**
 * Lays the nodes out in four columns, each layer stacked in document order.
 *
 * Deliberately deterministic and computed here rather than by a layout engine:
 * the picture a reader compares with a colleague's screenshot has to be the same
 * picture, and the ordering it is stacked in is the signed document's own.
 */
function positioned(nodes: GraphNode[]): PositionedNode[] {
  const used = new Map<number, number>();
  return nodes.map((node) => {
    const row = used.get(node.layer) ?? 0;
    used.set(node.layer, row + 1);
    return { ...node, position: { x: node.layer * COLUMN_WIDTH, y: row * ROW_HEIGHT } };
  });
}

/** How each layer reads in the graph's column headings and in the legend. */
export const LAYER_LABELS: Record<NodeKind, string> = {
  host: 'Ingress host',
  service: 'Service',
  workload: 'Workload',
  container: 'Container',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function at(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function stringAt(value: unknown, path: readonly string[]): string | null {
  const found = at(value, path);
  return typeof found === 'string' && found.length > 0 ? found : null;
}

function recordAt(value: unknown, path: readonly string[]): Record<string, unknown> | null {
  const found = at(value, path);
  return isRecord(found) ? found : null;
}

function arrayAt(value: unknown, path: readonly string[]): unknown[] {
  const found = at(value, path);
  return Array.isArray(found) ? found : [];
}
