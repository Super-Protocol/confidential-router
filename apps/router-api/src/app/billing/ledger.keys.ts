/**
 * The ledger idempotency keys another module has to be able to recognise, not
 * just write.
 *
 * `LedgerService` spells its own keys inline where the event it is recording is
 * the only reader. The usage debit is the exception: the deployment export has
 * to tell a per-request debit from every other kind of entry, because the
 * generation it names is deliberately left behind (SUP-446), and a prefix
 * written out in two places is a prefix that will be changed in one.
 */

/** {@link generationLedgerKey}'s prefix. One usage debit per metered request. */
export const GENERATION_LEDGER_KEY_PREFIX = 'generation:';

/**
 * The key of the usage debit for one generation, keyed on the generation id so a
 * retried metering write cannot charge the same request twice.
 */
export function generationLedgerKey(generationId: string): string {
  return `${GENERATION_LEDGER_KEY_PREFIX}${generationId}`;
}
