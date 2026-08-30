import { describe, expect, it } from 'vitest';
import { computeCostMicros, tokensPerSecond } from './pricing.js';

const PRICING = { promptPer1mMicros: 280_000, completionPer1mMicros: 420_000 };

describe('computeCostMicros', () => {
  it('prices prompt and completion tokens per million', () => {
    // 1M prompt tokens at 280000 micros/M plus 1M completion at 420000/M.
    expect(computeCostMicros({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, PRICING)).toBe(700_000);
  });

  it('rounds the total up, so a metered request is never free', () => {
    // 1 × 0.28 + 1 × 0.42 = 0.7 micro-USD.
    expect(computeCostMicros({ promptTokens: 1, completionTokens: 1 }, PRICING)).toBe(1);
  });

  it('rounds the sum once rather than each side separately', () => {
    const together = computeCostMicros({ promptTokens: 5, completionTokens: 5 }, PRICING);
    const separately =
      computeCostMicros({ promptTokens: 5, completionTokens: 0 }, PRICING) +
      computeCostMicros({ promptTokens: 0, completionTokens: 5 }, PRICING);

    expect(together).toBe(4);
    expect(separately).toBe(5);
  });

  it('is zero for a request that consumed nothing', () => {
    expect(computeCostMicros({ promptTokens: 0, completionTokens: 0 }, PRICING)).toBe(0);
  });

  it('is free when the model is priced at zero', () => {
    const free = { promptPer1mMicros: 0, completionPer1mMicros: 0 };

    expect(computeCostMicros({ promptTokens: 10_000, completionTokens: 10_000 }, free)).toBe(0);
  });

  it('ignores negative counts rather than crediting them back', () => {
    expect(computeCostMicros({ promptTokens: -100, completionTokens: 1_000_000 }, PRICING)).toBe(420_000);
  });

  it('stays exact at realistic volumes', () => {
    // A 128k-token prompt with a 4k answer: exercised as one integer product.
    expect(computeCostMicros({ promptTokens: 131_072, completionTokens: 4_096 }, PRICING)).toBe(
      Math.ceil((131_072 * 280_000 + 4_096 * 420_000) / 1_000_000),
    );
  });
});

describe('tokensPerSecond', () => {
  it('reports the generation rate', () => {
    expect(tokensPerSecond(100, 2_000)).toBe(50);
  });

  it('is null when there is nothing to divide', () => {
    expect(tokensPerSecond(0, 2_000)).toBeNull();
    expect(tokensPerSecond(100, 0)).toBeNull();
  });
});
