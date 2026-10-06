import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The repository's one reversible secret at rest.
 *
 * Every other credential this service holds is hashed and compared — an API key
 * (`api-keys/api-key-token.ts`), an invite code, a salted request attribute. The
 * upstream LLM API key of an external endpoint (ADR-008 §6) cannot be: the router
 * has to *send* it when it proxies, so it has to be able to read it back.
 *
 * The TEE's LUKS disk already encrypts the database file. What this envelope adds
 * is that the plaintext is absent from SQL, from a `pg_dump`, from PostgreSQL's
 * shared buffers and from a stray log line — the places a disk key does not reach.
 * Threat T15 states the residual plainly: while a request is being proxied the
 * plaintext is in router-api's memory, which is the same class as T5.
 *
 * Deliberately pure, with no Nest and no database, for the same reason
 * `api-key-token.ts` is: this is the part of credential handling that has to be
 * provably right, and a pure function is the only part you can prove.
 *
 * Properties the tests pin:
 *  - the key never comes from the config file, only from the environment
 *    ({@link SECRETS_KEY_ENV}) — SUP-124's rule, because a rendered ConfigMap is
 *    readable inside the published evidence;
 *  - no error message, no `toString`, no `JSON.stringify` and no log record ever
 *    carries the key or a plaintext;
 *  - a ciphertext is bound to the row that owns it, so moving one between rows
 *    in SQL fails to open rather than silently handing the wrong upstream a key.
 */

/** Where the 32-byte data key comes from. Never `conf/router.yaml` (ADR-008 §6, SUP-124). */
export const SECRETS_KEY_ENV = 'CR_API_SECRETS_KEY';

/** AES-256. */
const KEY_BYTES = 32;

/** 96 bits, the length GCM is specified and optimised for. */
const IV_BYTES = 12;

const TAG_BYTES = 16;

/** Marks the envelope format, so a future algorithm change is a new prefix rather than a guess. */
const VERSION = 'v1';

export class MissingSecretsKeyError extends Error {
  constructor() {
    super(
      `${SECRETS_KEY_ENV} is required to store an external endpoint's upstream API key. ` +
        'Set it to 32 random bytes, base64url- or hex-encoded (`openssl rand -base64 32`), ' +
        'from a Kubernetes Secret — never from the config file, which is readable inside the ' +
        'published evidence. Rotating it makes every stored upstream key unreadable; re-enter them.',
    );
    this.name = 'MissingSecretsKeyError';
  }
}

export class MalformedSecretsKeyError extends Error {
  constructor(reason: string) {
    // The reason describes the encoding, never the value: this message reaches
    // the log on a failed boot.
    super(`${SECRETS_KEY_ENV} is not a usable AES-256 key: ${reason}.`);
    this.name = 'MalformedSecretsKeyError';
  }
}

export class SecretDecryptionError extends Error {
  constructor(reason: string) {
    super(`A stored secret could not be opened: ${reason}.`);
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Decodes the data key from its environment value.
 *
 * Base64, base64url and hex are all accepted because all three are what an
 * operator's key generator prints, and guessing wrong would be a boot failure
 * with a confusing cause. Whatever the spelling, it has to decode to exactly 32
 * bytes — a shorter one is a typo, a longer one is a different secret.
 */
export function parseSecretsKey(value: string | undefined): Buffer {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new MissingSecretsKeyError();
  }
  const decoded = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64url');
  if (decoded.length !== KEY_BYTES) {
    throw new MalformedSecretsKeyError(`it decodes to ${decoded.length} bytes, and AES-256 needs ${KEY_BYTES}`);
  }
  return decoded;
}

/**
 * Seals `plaintext` under `key`, bound to `context`.
 *
 * `context` is the GCM additional authenticated data and is not secret — it is
 * the id of the row the ciphertext belongs to. Binding it is what stops a
 * ciphertext being copied from one external endpoint's row to another's: the
 * copy decrypts to nothing, so a database writer cannot redirect one upstream's
 * credential to a different upstream.
 *
 * The output is `v1.<base64url(iv || ciphertext || tag)>`: one opaque string,
 * which is the only shape a column, a migration and a rotation have to agree on.
 */
export function sealSecret(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const packed = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
  return `${VERSION}.${packed.toString('base64url')}`;
}

/**
 * Opens an envelope produced by {@link sealSecret}.
 *
 * Every failure — wrong key, wrong context, truncated or tampered payload — is
 * the same {@link SecretDecryptionError} with a reason that describes the shape
 * and never the bytes. There is nothing to learn from which one it was, and a
 * message that quoted the ciphertext would put it in the log.
 */
export function openSecret(key: Buffer, envelope: string, context: string): string {
  const [version, payload, ...rest] = envelope.split('.');
  if (version !== VERSION || !payload || rest.length > 0) {
    throw new SecretDecryptionError(`the envelope is not in the ${VERSION} format`);
  }
  const packed = Buffer.from(payload, 'base64url');
  if (packed.length < IV_BYTES + TAG_BYTES) {
    throw new SecretDecryptionError('the envelope is shorter than a nonce and a tag');
  }
  const iv = packed.subarray(0, IV_BYTES);
  const ciphertext = packed.subarray(IV_BYTES, packed.length - TAG_BYTES);
  const tag = packed.subarray(packed.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM's own failure. It means one of: wrong key, wrong context, altered
    // bytes — and the whole point of an AEAD is that they are indistinguishable.
    throw new SecretDecryptionError('the key, the binding or the payload does not match');
  }
}

/** What the console shows for a credential it cannot read: the first few characters. */
export const SECRET_DISPLAY_PREFIX_LENGTH = 8;

/**
 * The display prefix of a plaintext credential, the only part of it that is kept.
 *
 * Eight characters, like `api-key-token.ts`'s twelve, for the same purpose and
 * with the same reasoning: enough for an operator to tell which of two keys a row
 * holds, far short of enough to guess the rest. Upstream keys are other services'
 * formats, so this takes a prefix rather than assuming one.
 */
export function secretDisplayPrefix(plaintext: string): string {
  return plaintext.slice(0, SECRET_DISPLAY_PREFIX_LENGTH);
}
