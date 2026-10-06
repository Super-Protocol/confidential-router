/**
 * Allocation of the sidecar's per-endpoint loopback listeners (ADR-008 §4).
 *
 * "Deterministic" here means a function of the ports already taken, not of the
 * endpoint's name: a hash of the name would collide, and resolving a collision by
 * probing would make the result depend on insertion order anyway. The lowest free
 * port in the window is the one answer that is stable across restarts for a given
 * set of rows — and the row keeps it, so a restart renders the same file.
 *
 * The window is bounded because a port is a real resource in the pod and an
 * unbounded allocator would wander into whatever else is listening on loopback.
 */

export class NoFreeListenPortError extends Error {
  constructor(base: number, range: number) {
    super(
      `Every loopback port in [${base}, ${base + range}) is taken, so no further external endpoint can be ` +
        'given a listener. Raise externalEndpoints.listenPortRange.',
    );
    this.name = 'NoFreeListenPortError';
  }
}

/** The lowest port in `[base, base + range)` that `taken` does not contain. */
export function allocateListenPort(base: number, range: number, taken: Iterable<number>): number {
  const used = new Set(taken);
  for (let port = base; port < base + range; port += 1) {
    if (!used.has(port)) {
      return port;
    }
  }
  throw new NoFreeListenPortError(base, range);
}
