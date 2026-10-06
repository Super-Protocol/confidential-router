'use client';

import * as React from 'react';
import { publicConfig } from '../../../lib/public-config';
import { type EndpointKind, type GateResult, runEvidenceGate } from './evidence-gate';
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
  /**
   * Whose endpoint this is. `external` reads the bundle through this router's
   * relay only, and asks no extension — see {@link useVerification}.
   */
  kind?: EndpointKind;
}

/**
 * Runs both browser-side verification tiers for one endpoint, and re-runs them
 * when the chosen model moves the chat to a different one.
 *
 * The two tiers are independent on purpose: the extension's answer is worth
 * something precisely because it does not depend on anything this page computed,
 * so it is asked in parallel rather than after tier 1 passes. An absent extension
 * resolves as "absent" after a short timeout and never blocks anything.
 *
 * ## For an external upstream, tier 2 is not asked at all
 *
 * The extension reports on a *hostname the browser connects to*: it fetches that
 * host's evidence itself and speaks to the channel the user's traffic takes.
 * Toward an external upstream the browser has no such channel — the traffic goes
 * to this router, which proxies over a connection its egress sidecar attested and
 * pinned (ADR-008 §1). Asking the extension about the upstream would produce a
 * confident second opinion about a connection nobody in this browser is using,
 * rendered beside a tier-1 result about a relayed document.
 *
 * So the outcome is *set* to `absent` rather than left null. Null is `pending`
 * (`extensionTierState`), and a row that waits forever reads as a handshake that
 * failed rather than one nobody made.
 *
 * **The caveat, because `absent` is being borrowed here.** It properly means "no
 * extension is installed"; what is meant is "this tier does not apply to this
 * endpoint". Nothing misleads today — the panel renders extension rows only on a
 * `verified` outcome, and `badgeTier` treats `unavailable` as never blocking, so
 * the borrowed value is never drawn. A reader who makes those rows render
 * unconditionally would be the first person this costs, and at that point the
 * honest fix is a `not-applicable` variant on `BridgeOutcome` rather than a
 * second meaning for this one.
 */
export function useVerification({ hostname, endpointName, kind = 'own' }: UseVerificationInput): VerificationState {
  const [gate, setGate] = React.useState<GateResult | null>(null);
  const [checkedAt, setCheckedAt] = React.useState<Date | null>(null);
  const [extension, setExtension] = React.useState<BridgeOutcome | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is how "check again" re-runs both tiers; the body never reads it.
  React.useEffect(() => {
    /*
     * Cleared first, and before the early return, because the early return is a
     * state the composer must not inherit a verdict into.
     *
     * Until ADR-008 "no endpoint" meant the catalogue was empty, so there was no
     * model to send to and nothing could have run before. Now `Model.endpoint` is
     * nullable, and a reader can switch from a model whose endpoint tier 1 passed
     * on to one the screen has no endpoint for at all (`routerEndpoint` null on a
     * multi-endpoint deployment). Returning early with the old `gate` still in
     * state would leave `unlocked` true — an open composer, no badge row, and a
     * verdict about a different endpoint.
     */
    setGate(null);
    setCheckedAt(null);
    setExtension(null);
    if (!hostname || !endpointName) return;

    // Guards against a stale answer landing after the user has switched models:
    // the endpoint that is current when the promise resolves is the only one
    // whose verdict may be shown.
    let current = true;

    void runEvidenceGate({ hostname, endpointName, kind, apiOrigin: publicConfig().apiOrigin }).then((result) => {
      if (!current) return;
      setGate(result);
      setCheckedAt(new Date());
    });
    if (kind === 'external') {
      setExtension({ status: 'absent' });
    } else {
      void requestExtensionVerification({ hostname }).then((outcome) => {
        if (current) setExtension(outcome);
      });
    }

    return () => {
      current = false;
    };
  }, [hostname, endpointName, kind, attempt]);

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
