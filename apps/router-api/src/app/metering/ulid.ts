import { randomBytes } from 'node:crypto';

/**
 * ULID: 48 bits of millisecond timestamp + 80 bits of randomness, Crockford
 * base32, 26 characters.
 *
 * Hand-rolled rather than a dependency because it is twenty lines and the
 * property that matters here is the one a UUIDv4 lacks: generation ids sort by
 * creation time, so the Logs screen can page on the primary key.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

export function ulid(now: number = Date.now()): string {
  let time = '';
  let remaining = now;
  for (let index = 0; index < TIME_CHARS; index += 1) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }

  const bytes = randomBytes(RANDOM_CHARS);
  let random = '';
  for (const byte of bytes) {
    // One character per byte: 5 of the 8 bits, which keeps the mapping uniform
    // (256 is not a multiple of 32 only if you use all of them).
    random += CROCKFORD[byte & 0x1f];
  }
  return time + random;
}

/** The id of a generation, and of the OpenAI response that carries it. */
export function generationId(): string {
  return `gen-${ulid()}`;
}
