/** Injection token for the credits implementation the gateway talks to. */
export const CREDITS_GATEWAY = Symbol('CREDITS_GATEWAY');

export interface CreditsBalance {
  /** False once the workspace is out of credit; the gateway answers 402. */
  spendable: boolean;
  balanceMicros: number;
}

export interface CreditsDebit {
  workspaceId: string;
  generationId: string;
  amountMicros: number;
}

/**
 * What `/v1` needs from billing: may this workspace spend, and here is what it
 * spent.
 *
 * An interface rather than a direct dependency on the ledger, so the gateway
 * depends on the two questions it actually asks and not on how credits are
 * accounted for. `LedgerCreditsGateway` (SUP-75) is the implementation
 * `MeteringModule` binds under `CREDITS_GATEWAY`.
 */
export interface CreditsGateway {
  balanceOf(workspaceId: string): Promise<CreditsBalance>;
  debit(input: CreditsDebit): Promise<void>;
}
