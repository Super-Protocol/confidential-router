'use client';

import * as React from 'react';
import { publicConfig } from '../../../lib/public-config';
import { type GateResult, runEvidenceGate } from './evidence-gate';
import { type BridgeOutcome, requestExtensionVerification } from './extension-bridge';
import { extensionTierState, pageTierState, type TierState } from './tiers';

export interface VerificationState {
  /** Tier 1, run in this page. Null while it is still running. */
  gate: GateResult | null;
  /** Tier 2. Null while the handshake is outstanding. */
  extension: BridgeOutcome | null;
  /**
   * When tier 1 concluded, in this browser's clock. Null while it is running.
   *
   * The inspector shows it beside the evidence's own `issuedAt`, which is the
   * pair that matters: a bundle signed two minutes ago and checked two minutes
   * ago is a different statement from the same bundle checked yesterday, and the
   * second is what a left-open tab shows.
   */
  checkedAt: Date | null;
  pageState: TierState;
  extensionState: TierState;
  /** True once tier 1 has passed. The composer is disabled until it is. */
  unlocked: boolean;
  recheck: () => void;
}

export interface UseVerificationInput {
  hostname: string | null;
  endpointName: string | null;
}

/**
 * Runs both browser-side verification tiers for one endpoint, and re-runs them
 * when the chosen model moves the chat to a different one.
 *
 * The two tiers are independent on purpose: the extension's answer is worth
 * something precisely because it does not depend on anything this page computed,
 * so it is asked in parallel rather than after tier 1 passes. An absent extension
 * resolves as "absent" after a short timeout and never blocks anything.
 */
export function useVerification({ hostname, endpointName }: UseVerificationInput): VerificationState {
  const [gate, setGate] = React.useState<GateResult | null>(null);
  const [checkedAt, setCheckedAt] = React.useState<Date | null>(null);
  const [extension, setExtension] = React.useState<BridgeOutcome | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is how "check again" re-runs both tiers; the body never reads it.
  React.useEffect(() => {
    if (!hostname || !endpointName) return;

    // Guards against a stale answer landing after the user has switched models:
    // the endpoint that is current when the promise resolves is the only one
    // whose verdict may be shown.
    let current = true;
    setGate(null);
    setCheckedAt(null);
    setExtension(null);

    void runEvidenceGate({ hostname, endpointName, apiOrigin: publicConfig().apiOrigin }).then((result) => {
      if (!current) return;
      setGate(result);
      setCheckedAt(new Date());
    });
    void requestExtensionVerification({ hostname }).then((outcome) => {
      if (current) setExtension(outcome);
    });

    return () => {
      current = false;
    };
  }, [hostname, endpointName, attempt]);

  const pageState = pageTierState(gate);
  const extensionState = extensionTierState(extension);

  return {
    gate,
    checkedAt,
    extension,
    pageState,
    extensionState,
    unlocked: gate?.unlocked === true,
    recheck: React.useCallback(() => setAttempt((value) => value + 1), []),
  };
}
