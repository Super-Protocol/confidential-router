import { describe, expect, it } from 'vitest';
import { InvalidMeasurementError, normaliseMeasurement } from './measurement.js';

const HEX = 'ab'.repeat(32);

describe('normaliseMeasurement', () => {
  it('accepts the canonical form unchanged', () => {
    expect(normaliseMeasurement(HEX)).toBe(HEX);
  });

  it('folds every spelling the config schema accepts onto one value', () => {
    // The point of the function: one cloud, however it was pasted, is one row —
    // so the unique index can make a second add a conflict rather than a
    // duplicate an operator would have to remove twice.
    const spellings = [HEX.toUpperCase(), `sha256:${HEX}`, `SHA256:${HEX.toUpperCase()}`, `0x${HEX}`, `  ${HEX}  `];

    expect(spellings.map(normaliseMeasurement)).toEqual(spellings.map(() => HEX));
  });

  it('refuses anything that is not 64 hex characters, and names the value', () => {
    for (const bad of ['', 'not-hex', HEX.slice(0, 63), `${HEX}a`, `sha512:${HEX}`, `${'g'.repeat(64)}`]) {
      expect(() => normaliseMeasurement(bad)).toThrow(InvalidMeasurementError);
    }
    expect(() => normaliseMeasurement('oops')).toThrow(/"oops" is not a VM launch measurement/);
  });

  it('does not strip a prefix that only looks like one', () => {
    // `0xab…` with 64 hex after the prefix is a prefixed value; `0x` followed by
    // 62 is a typo, and reporting it as such beats storing 62 characters.
    expect(() => normaliseMeasurement(`0x${HEX.slice(0, 62)}`)).toThrow(InvalidMeasurementError);
  });
});
