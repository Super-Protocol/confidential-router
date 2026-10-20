import { describe, expect, it } from 'vitest';
import { readCoverage } from './evidence-coverage';

describe('readCoverage', () => {
  it('reports the ratio over the coverable requests, not over every request', () => {
    const reading = readCoverage({
      requests: 10,
      coveredRequests: 8,
      coverableRequests: 10,
      evidenceCoverage: 0.8,
    });

    expect(reading.ratio).toBe(0.8);
    expect(reading.headline).toBe('8 of 10 served with published evidence');
    expect(reading.detail).toBe('8 of 10 generations were served while the endpoint had a fresh bundle published.');
  });

  it('has no ratio at all when every generation went to an external endpoint', () => {
    // SUP-421, verbatim from production: 34 generations, each one served by an
    // external endpoint this router verified, each row carrying that endpoint's
    // digest. The screen read "Evidence coverage 0% — 0 of 34 generations were
    // served while the endpoint had a fresh bundle published".
    const reading = readCoverage({
      requests: 34,
      coveredRequests: 0,
      coverableRequests: 0,
      evidenceCoverage: null,
    });

    expect(reading.ratio).toBeNull();
    expect(reading.headline).toBe('Not applicable · all 34 served by external endpoints');
    expect(reading.detail).toContain('coverage does not apply here');
    expect(reading.detail).toContain('all 34 generations were served by external endpoints');
    expect(reading.detail).toContain('verified by this router');
    expect(reading.detail).not.toContain('0 of 34');
  });

  it('agrees with itself when the API sends a ratio of 0 next to an empty denominator', () => {
    // A client of an older API, or a bucket serialised before the ratio became
    // nullable: the denominator is the authority, not the ratio.
    const reading = readCoverage({
      requests: 34,
      coveredRequests: 0,
      coverableRequests: 0,
      evidenceCoverage: 0,
    });

    expect(reading.ratio).toBeNull();
    expect(reading.headline).toContain('Not applicable');
  });

  it('names both sides when the window mixes this platform’s endpoints with external ones', () => {
    const reading = readCoverage({
      requests: 50,
      coveredRequests: 8,
      coverableRequests: 10,
      evidenceCoverage: 0.8,
    });

    expect(reading.ratio).toBe(0.8);
    expect(reading.headline).toBe('8 of 10 on this platform’s endpoints · 40 external');
    expect(reading.detail).toContain('8 of 10 generations on this platform’s own endpoints');
    expect(reading.detail).toContain('The other 40 went to external endpoints, verified by this router.');
  });

  it('says nothing was served, rather than nothing was covered, for an empty period', () => {
    const reading = readCoverage({
      requests: 0,
      coveredRequests: 0,
      coverableRequests: 0,
      evidenceCoverage: null,
    });

    expect(reading.ratio).toBeNull();
    expect(reading.detail).toBe('No generations were served in this period.');
  });

  it('keeps 100% a claim about publication, with the covered count spelled out', () => {
    const reading = readCoverage({
      requests: 10_900,
      coveredRequests: 10_900,
      coverableRequests: 10_900,
      evidenceCoverage: 1,
    });

    expect(reading.ratio).toBe(1);
    expect(reading.headline).toBe('10.9K of 10.9K served with published evidence');
  });

  it('says it in the singular for a single external generation', () => {
    const reading = readCoverage({
      requests: 1,
      coveredRequests: 0,
      coverableRequests: 0,
      evidenceCoverage: null,
    });

    expect(reading.headline).toBe('Not applicable · one external generation');
    expect(reading.detail).toContain('the one generation was served by an external endpoint, verified by this router');
  });
});
