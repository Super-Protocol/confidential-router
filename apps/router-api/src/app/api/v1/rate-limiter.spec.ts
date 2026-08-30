import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTokenBucketRateLimiter } from './rate-limiter.js';

const MINUTE = 60_000;

let limiter: InMemoryTokenBucketRateLimiter;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-30T12:00:00Z'));
  limiter = new InMemoryTokenBucketRateLimiter();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('consume', () => {
  it('allows a full minute of budget and refuses the next call', async () => {
    for (let index = 0; index < 3; index += 1) {
      expect((await limiter.consume('key', { cost: 1, limitPerMinute: 3 })).allowed).toBe(true);
    }

    expect((await limiter.consume('key', { cost: 1, limitPerMinute: 3 })).allowed).toBe(false);
  });

  it('keeps buckets independent', async () => {
    await limiter.consume('a', { cost: 1, limitPerMinute: 1 });

    expect((await limiter.consume('b', { cost: 1, limitPerMinute: 1 })).allowed).toBe(true);
  });

  it('refills continuously rather than in a fixed window', async () => {
    await limiter.consume('key', { cost: 60, limitPerMinute: 60 });
    expect((await limiter.consume('key', { cost: 1, limitPerMinute: 60 })).allowed).toBe(false);

    // One second of a 60/minute budget is exactly one request back.
    vi.advanceTimersByTime(1_000);
    expect((await limiter.consume('key', { cost: 1, limitPerMinute: 60 })).allowed).toBe(true);
    expect((await limiter.consume('key', { cost: 1, limitPerMinute: 60 })).allowed).toBe(false);
  });

  it('never accumulates more than one minute of budget', async () => {
    vi.advanceTimersByTime(10 * MINUTE);

    for (let index = 0; index < 5; index += 1) {
      await limiter.consume('key', { cost: 1, limitPerMinute: 5 });
    }

    expect((await limiter.consume('key', { cost: 1, limitPerMinute: 5 })).allowed).toBe(false);
  });

  it('reports how long the caller has to wait', async () => {
    await limiter.consume('key', { cost: 60, limitPerMinute: 60 });
    const refused = await limiter.consume('key', { cost: 30, limitPerMinute: 60 });

    expect(refused.allowed).toBe(false);
    expect(refused.limit).toBe(60);
    expect(refused.remaining).toBe(0);
    // Half a minute of budget is owed: 30 seconds.
    expect(refused.retryAfterSeconds).toBe(30);
    expect(refused.resetAt).toBe(Date.now() + 30_000);
  });

  it('does not spend the budget of a call it refuses', async () => {
    await limiter.consume('key', { cost: 2, limitPerMinute: 2 });
    await limiter.consume('key', { cost: 5, limitPerMinute: 2 });
    vi.advanceTimersByTime(MINUTE);

    expect((await limiter.consume('key', { cost: 2, limitPerMinute: 2 })).allowed).toBe(true);
  });

  it('lets a zero-cost call peek at the remaining budget', async () => {
    await limiter.consume('key', { cost: 4, limitPerMinute: 10 });
    const peek = await limiter.consume('key', { cost: 0, limitPerMinute: 10 });

    expect(peek.allowed).toBe(true);
    expect(peek.remaining).toBe(6);
  });
});

describe('debit', () => {
  it('settles an amount that was not known up front', async () => {
    await limiter.debit('tokens', { cost: 900, limitPerMinute: 1_000 });
    const peek = await limiter.consume('tokens', { cost: 0, limitPerMinute: 1_000 });

    expect(peek.remaining).toBe(100);
  });

  it('floors an overshoot at zero, so one huge request costs at most the current minute', async () => {
    await limiter.debit('tokens', { cost: 10_000, limitPerMinute: 1_000 });
    expect((await limiter.consume('tokens', { cost: 0, limitPerMinute: 1_000 })).remaining).toBe(0);

    vi.advanceTimersByTime(MINUTE);
    expect((await limiter.consume('tokens', { cost: 0, limitPerMinute: 1_000 })).remaining).toBe(1_000);
  });
});
