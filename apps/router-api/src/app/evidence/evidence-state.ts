/**
 * The only three things the router is allowed to say about a published bundle.
 *
 * All three are statements about *publication and freshness* — facts the router
 * knows because it fetched the bundle itself. None of them is a verdict on the
 * evidence, which is the user's gatekeeper's job (ADR-002). The vocabulary rule
 * from the same ADR applies to every surface built on this type: published,
 * signed, fresh, stale — never verified, trusted, or attested by.
 */
export type EvidenceState = 'PUBLISHED' | 'STALE' | 'NOT_PUBLISHED';

export interface PublishedAt {
  issuedAt: Date;
}

/** Age of the quote, in milliseconds, at `now`. Negative ages are clamped to 0. */
export function quoteAgeMs(snapshot: PublishedAt, now: Date = new Date()): number {
  return Math.max(0, now.getTime() - snapshot.issuedAt.getTime());
}

/**
 * @param snapshot the endpoint's latest snapshot, or null when nothing has been
 *   fetched yet — a fetch that failed and one that never happened are the same
 *   state, because the router has nothing published to show either way.
 */
export function evidenceStateOf(
  snapshot: PublishedAt | null | undefined,
  freshnessWindowMs: number,
  now: Date = new Date(),
): EvidenceState {
  if (!snapshot) {
    return 'NOT_PUBLISHED';
  }
  return quoteAgeMs(snapshot, now) <= freshnessWindowMs ? 'PUBLISHED' : 'STALE';
}
