import { describe, expect, it } from 'vitest';
import { allocateListenPort, NoFreeListenPortError } from './listen-port.js';

describe('allocateListenPort', () => {
  it('starts at the base when nothing is taken', () => {
    expect(allocateListenPort(19_000, 8, [])).toBe(19_000);
  });

  it('gives the same answer for the same set, however it is ordered', () => {
    // "Deterministic" is the property the row depends on: a restart renders the
    // same config, so an endpoint keeps the port the egress leg points at.
    expect(allocateListenPort(19_000, 8, [19_000, 19_002])).toBe(19_001);
    expect(allocateListenPort(19_000, 8, [19_002, 19_000])).toBe(19_001);
  });

  it('fills a gap left by a deleted endpoint rather than growing', () => {
    expect(allocateListenPort(19_000, 8, [19_000, 19_001, 19_003])).toBe(19_002);
  });

  it('refuses once the window is full, naming the setting that widens it', () => {
    const full = [19_000, 19_001, 19_002];

    expect(() => allocateListenPort(19_000, 3, full)).toThrow(NoFreeListenPortError);
    expect(() => allocateListenPort(19_000, 3, full)).toThrow(/listenPortRange/);
  });

  it('ignores ports outside its window', () => {
    expect(allocateListenPort(19_000, 2, [80, 443, 20_000])).toBe(19_000);
  });
});
