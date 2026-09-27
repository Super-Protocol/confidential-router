import { describe, expect, it } from 'vitest';
import { isLoopbackUrl } from './loopback.js';

describe('isLoopbackUrl', () => {
  it.each([
    'http://localhost:3000',
    'http://localhost',
    'https://console.localhost:4200',
    'http://127.0.0.1:3000',
    'http://127.1.2.3',
    'http://[::1]:3000',
  ])('treats %s as reachable only from this machine', (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    'https://api.router.superprotocol.com',
    'http://10.0.0.5:3000',
    // A wildcard bind address, not a loopback one: a browser on another host that
    // resolves it reaches this process.
    'http://0.0.0.0:3000',
    // The trick a check on the string "localhost" would fall for.
    'https://localhost.attacker.example',
    'https://127.0.0.1.attacker.example',
  ])('treats %s as public', (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });

  it('treats an unparseable value as public, because it is not evidence of anything', () => {
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});
