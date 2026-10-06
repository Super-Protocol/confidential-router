import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  MissingSecretsKeyError,
  openSecret,
  parseSecretsKey,
  SECRETS_KEY_ENV,
  sealSecret,
  secretDisplayPrefix,
} from './secret-envelope.js';

/** What a caller gets back for a credential it has just handed over. */
export interface SealedSecret {
  /** The `v1.…` envelope — the only form that reaches the database. */
  ciphertext: string;
  /** Leading characters of the plaintext, kept for display. */
  prefix: string;
}

/**
 * The service half of {@link sealSecret} / {@link openSecret}: one place that
 * holds the data key, and the only place in the process that can read a stored
 * credential back.
 *
 * The key is read from the environment lazily rather than in the constructor.
 * A deployment with no external endpoints registered needs no key, and refusing
 * to boot without one would make an optional feature mandatory; the first
 * registration is where the requirement becomes real, and {@link available}
 * is how a caller asks before promising an admin anything.
 *
 * Nothing here logs a plaintext, and the instance is unprintable on purpose:
 * `toJSON` is what a pino serialiser or a `JSON.stringify` of a Nest error
 * context would reach for, and it must not find a key behind it.
 */
@Injectable()
export class SecretEnvelopeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SecretEnvelopeService.name);
  private key: Buffer | null = null;

  onApplicationBootstrap(): void {
    // Said once, at boot, so an operator learns about the missing key before an
    // admin does — and never with the value, whether it is there or not.
    this.logger.log(
      this.available()
        ? 'Secret envelope: a data key is configured; upstream API keys can be stored.'
        : `Secret envelope: ${SECRETS_KEY_ENV} is not set. Registering an external endpoint will be refused.`,
    );
  }

  /** Whether a usable data key is configured. A malformed one is not available, and says why. */
  available(): boolean {
    try {
      this.dataKey();
      return true;
    } catch (error) {
      if (!(error instanceof MissingSecretsKeyError)) {
        // A key that is set but unusable is an operator mistake rather than an
        // unconfigured feature, so it is worth naming. The message describes the
        // encoding, never the value.
        this.logger.error(error instanceof Error ? error.message : String(error));
      }
      return false;
    }
  }

  /**
   * Seals a credential for storage under `context` — the id of the row that will
   * hold it (see {@link sealSecret} on why the binding matters).
   */
  seal(plaintext: string, context: string): SealedSecret {
    return { ciphertext: sealSecret(this.dataKey(), plaintext, context), prefix: secretDisplayPrefix(plaintext) };
  }

  /**
   * Opens a stored credential. The only read path, and it exists for one caller:
   * the egress leg that injects `Authorization` toward the upstream.
   */
  open(ciphertext: string, context: string): string {
    return openSecret(this.dataKey(), ciphertext, context);
  }

  private dataKey(): Buffer {
    this.key ??= parseSecretsKey(process.env[SECRETS_KEY_ENV]);
    return this.key;
  }

  /** Keeps the data key out of any structured log record or serialised error context. */
  toJSON(): string {
    return '[SecretEnvelopeService]';
  }
}
