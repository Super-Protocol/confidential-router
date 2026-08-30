/** Injection token for the rate-limiter implementation. */
export const RATE_LIMITER = Symbol('RATE_LIMITER');

export interface RateLimitRequest {
  /** How much of the bucket the caller wants — 1 request, or N tokens. */
  cost: number;
  limitPerMinute: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  /** Whole units left in the bucket after this call. */
  remaining: number;
  /** Epoch milliseconds at which the bucket is full again. */
  resetAt: number;
  retryAfterSeconds: number;
}

/**
 * A minute-window budget, per named bucket.
 *
 * An interface rather than a concrete class because a multi-replica deployment
 * needs one shared budget: the in-process implementation below is correct for a
 * single replica and for every test, and a Redis adapter drops in under the
 * `RATE_LIMITER` token without any caller changing.
 *
 * `consume` and `debit` are split because the two limits behave differently.
 * Requests are known before dispatch and are refused outright. Tokens are only
 * known after the model has answered, so the gateway checks that the bucket is
 * not already empty (`consume` with cost 0) and settles the real amount
 * afterwards (`debit`) — a request may overshoot its budget by its own size,
 * never by more.
 */
export interface RateLimiter {
  consume(bucket: string, request: RateLimitRequest): Promise<RateLimitDecision>;
  debit(bucket: string, request: RateLimitRequest): Promise<void>;
}

interface Bucket {
  /** Units available, as a fraction — refill is continuous. */
  available: number;
  updatedAt: number;
}

const MS_PER_MINUTE = 60_000;

/** Buckets tracked before idle ones are swept; ~100 bytes each. */
const SWEEP_THRESHOLD = 10_000;

/**
 * Token bucket with a one-minute capacity and continuous refill.
 *
 * Continuous rather than a fixed window because a fixed window lets a client
 * spend two full budgets across a boundary; the bucket smooths that out while
 * still allowing a burst up to the whole minute's worth.
 */
export class InMemoryTokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  async consume(bucket: string, request: RateLimitRequest): Promise<RateLimitDecision> {
    const state = this.refill(bucket, request.limitPerMinute);
    const allowed = state.available >= request.cost;
    if (allowed) {
      state.available -= request.cost;
    }
    return this.decide(state, request, allowed);
  }

  async debit(bucket: string, request: RateLimitRequest): Promise<void> {
    const state = this.refill(bucket, request.limitPerMinute);
    // Floored at zero rather than allowed to go negative: an overshoot costs
    // the offender the rest of the current minute, not the next several.
    state.available = Math.max(0, state.available - request.cost);
  }

  /** Test seam — the process-wide singleton otherwise leaks state across suites. */
  reset(): void {
    this.buckets.clear();
  }

  private refill(bucket: string, limitPerMinute: number): Bucket {
    const now = Date.now();
    const existing = this.buckets.get(bucket);
    if (!existing) {
      const created = { available: limitPerMinute, updatedAt: now };
      this.sweep(now);
      this.buckets.set(bucket, created);
      return created;
    }
    const refilled = ((now - existing.updatedAt) / MS_PER_MINUTE) * limitPerMinute;
    existing.available = Math.min(limitPerMinute, existing.available + refilled);
    existing.updatedAt = now;
    return existing;
  }

  private decide(state: Bucket, request: RateLimitRequest, allowed: boolean): RateLimitDecision {
    const deficit = Math.max(0, request.cost - state.available);
    const msUntilAffordable = (deficit / request.limitPerMinute) * MS_PER_MINUTE;
    return {
      allowed,
      limit: request.limitPerMinute,
      remaining: Math.max(0, Math.floor(state.available)),
      resetAt: state.updatedAt + Math.ceil(msUntilAffordable),
      retryAfterSeconds: Math.max(1, Math.ceil(msUntilAffordable / 1000)),
    };
  }

  /**
   * Drops buckets that have refilled completely: they are indistinguishable
   * from a bucket that was never created, so keeping them only grows the map
   * for every key that ever made a request.
   */
  private sweep(now: number): void {
    if (this.buckets.size < SWEEP_THRESHOLD) {
      return;
    }
    for (const [name, state] of this.buckets) {
      if (now - state.updatedAt >= MS_PER_MINUTE) {
        this.buckets.delete(name);
      }
    }
  }
}
