import { createHash, randomBytes } from 'node:crypto';

/**
 * Minting and hashing of `/v1` credentials.
 *
 * Pure functions with no Nest and no database, because this is the part of key
 * handling that has to be provably right: the plaintext exists for the length
 * of one GraphQL response and is never recoverable afterwards.
 */

/** Marks the key as ours, and as version 1 of the format. */
export const API_KEY_PREFIX = 'sk-tee-v1-';

/** 32 random bytes — 256 bits of entropy, base64url-encoded to 43 characters. */
export const API_KEY_ENTROPY_BYTES = 32;

/** What the console shows for a key it can no longer read: `sk-tee-v1-4f`. */
export const API_KEY_DISPLAY_PREFIX_LENGTH = 12;

export interface MintedApiKey {
  /** The plaintext, returned to the caller exactly once. */
  secret: string;
  /** `sha256(secret)`, hex — the only form that reaches the database. */
  keyHash: string;
  /** Leading characters, stored for display. */
  prefix: string;
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function displayPrefixOf(secret: string): string {
  return secret.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}

export function mintApiKey(): MintedApiKey {
  const secret = `${API_KEY_PREFIX}${randomBytes(API_KEY_ENTROPY_BYTES).toString('base64url')}`;
  return { secret, keyHash: hashApiKey(secret), prefix: displayPrefixOf(secret) };
}

/**
 * Cheap shape check, used to reject obvious non-keys before touching the
 * database. It is not an authorisation decision — `ApiKeyService.authenticate`
 * still has to find the hash.
 */
export function looksLikeApiKey(value: string): boolean {
  return new RegExp(`^${API_KEY_PREFIX}[A-Za-z0-9_-]{43}$`).test(value);
}

/**
 * Whether a presented credential is a placeholder rather than a key.
 *
 * Three strings reach `/v1` as credentials without ever having been keys, and
 * all three are ones *we* put in front of the user: the `sk-tee-v1-…` the docs
 * and the console show where a key would go, and the `${input:…}` / `{env:…}`
 * references VS Code and OpenCode resolve from secret storage — left unresolved
 * when the file is pasted without the surrounding setup.
 *
 * They are worth telling apart from a wrong key because the failure is silent
 * in the other direction: the request is refused by the router, an IDE reports
 * it as a model failure (SUP-326), and the user's own `curl` — where they
 * pasted the real key — keeps working. "This is a placeholder" ends that in one
 * reading; "incorrect API key" does not.
 */
export function isCredentialPlaceholder(value: string): boolean {
  if (/^\$\{[^}]*\}$/.test(value) || /^\{env:[^}]*\}$/.test(value)) {
    return true;
  }
  // `sk-tee-v1-…` and the console's masked `sk-tee-v1-4f…`: the prefix is real,
  // the secret is an ellipsis. A minted key is base64url and never ends in one.
  return value.startsWith(API_KEY_PREFIX) && /(?:…|\.\.\.)$/.test(value);
}

/**
 * Extracts the credential from an `Authorization` header.
 *
 * Only `Bearer` — `/v1` takes no cookies and no query parameters (ADR-004 §6).
 */
export function bearerTokenOf(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
