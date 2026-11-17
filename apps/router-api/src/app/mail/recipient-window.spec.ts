import { describe, expect, it } from 'vitest';
import { RecipientWindow } from './recipient-window.js';

describe('RecipientWindow', () => {
  it('admits up to the limit within the window, then refuses', () => {
    let now = 0;
    const window = new RecipientWindow(2, 1000, () => now);

    expect(window.admit('a@example.com')).toBe(true);
    expect(window.admit('a@example.com')).toBe(true);
    expect(window.admit('a@example.com')).toBe(false);

    now = 999;
    expect(window.admit('a@example.com')).toBe(false);
    now = 1000;
    expect(window.admit('a@example.com')).toBe(true);
  });

  it('counts one inbox once, whatever the case of the address', () => {
    const window = new RecipientWindow(1, 1000, () => 0);

    expect(window.admit('Someone@Example.com')).toBe(true);
    expect(window.admit(' someone@example.com ')).toBe(false);
    expect(window.admit('other@example.com')).toBe(true);
  });
});
