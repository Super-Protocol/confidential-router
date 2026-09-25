import { createHash } from 'node:crypto';

/**
 * A one-way fingerprint of a request attribute we want to compare but must not
 * store.
 *
 * Salted with the deployment's `auth.secret` because the inputs are small
 * enumerable spaces: a bare `sha256` of an IPv4 address is reversible with a
 * table of four billion entries, and so is one of a common user-agent string.
 * With the secret mixed in, the column is only useful to someone who already has
 * the deployment's secret — at which point the hashes are the least of it.
 *
 * Hex-encoded and truncated to 64 characters, which is the width every column
 * that holds one of these declares.
 */
export function saltedHash(secret: string, value: string): string {
  return createHash('sha256').update(`${secret}:${value}`).digest('hex').slice(0, 64);
}
