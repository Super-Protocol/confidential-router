import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';

/**
 * A withdrawal the ledger refuses because it would take the balance below zero.
 *
 * Only operator adjustments reach this. Usage debits are exempt because a
 * completion's length is not known before it is generated (ADR-005 §3), and
 * refunds because the provider has already moved the money — in both cases the
 * balance goes negative and the *next* request is what gets refused. An
 * adjustment has a known amount and a human behind it, so refusing it surfaces
 * the mistake to someone who can act on it.
 *
 * `402` rather than `409` because that is the status `/v1` already uses for
 * `insufficient_credits` (`docs/contracts/router-api.md`).
 */
export class InsufficientCreditsError extends HttpException {
  constructor(balanceMicros: number, amountMicros: number) {
    super(
      `Insufficient credits: the balance is ${balanceMicros} micro-USD and this entry would remove ${-amountMicros}.`,
      HttpStatus.PAYMENT_REQUIRED,
    );
    this.name = 'InsufficientCreditsError';
  }
}

/** The ledger was asked to write an amount whose sign contradicts its kind. */
export class LedgerSignError extends ConflictException {
  constructor(kind: string, amountMicros: number) {
    super(`A ${kind} entry cannot have an amount of ${amountMicros} micro-USD.`);
    this.name = 'LedgerSignError';
  }
}
