/** Recipients tracked before expired ones are swept. */
const SWEEP_THRESHOLD = 10_000;

/**
 * At most `limit` admissions per key within a sliding `windowMs`.
 *
 * Not the token bucket in `api/v1/rate-limiter.ts`: that one's capacity is a
 * per-minute figure, and "three per hour" is a fraction of a request per
 * minute, which a bucket of that size never admits at all. Process-local, like
 * every limiter here — correct for the single replica a deployment runs.
 *
 * Keys are compared case-insensitively: they are mail addresses, and
 * `A@x.com` and `a@x.com` land in the same inbox.
 */
export class RecipientWindow {
  private readonly admitted = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  admit(key: string): boolean {
    const at = this.now();
    const normalized = key.trim().toLowerCase();
    const recent = (this.admitted.get(normalized) ?? []).filter((time) => at - time < this.windowMs);
    if (recent.length >= this.limit) {
      this.admitted.set(normalized, recent);
      return false;
    }
    recent.push(at);
    this.sweep(at);
    this.admitted.set(normalized, recent);
    return true;
  }

  private sweep(at: number): void {
    if (this.admitted.size < SWEEP_THRESHOLD) {
      return;
    }
    for (const [key, times] of this.admitted) {
      if (times.every((time) => at - time >= this.windowMs)) {
        this.admitted.delete(key);
      }
    }
  }
}
