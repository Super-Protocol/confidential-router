'use client';

import { Check, CircleHelp, CircleX } from 'lucide-react';
import type { CheckStatus, GateCheck } from './evidence-gate';
import { CHECK_LABELS } from './tiers';

/**
 * One tier-1 check, as both surfaces that list them render it.
 *
 * Shared between the badge's verification panel and the attestation inspector so
 * the two cannot drift: a check that reads as "not established" in one and as a
 * failure in the other would be the product disagreeing with itself about the
 * only thing it is careful never to overstate.
 */
export function CheckRow({ check }: { check: GateCheck }) {
  return (
    <li className="flex gap-2.5 text-sm">
      <CheckIcon status={check.status} />
      <div className="min-w-0">
        <p className="font-medium">{CHECK_LABELS[check.id]}</p>
        <p className="text-muted-foreground text-xs">{check.detail}</p>
      </div>
    </li>
  );
}

/**
 * Three states, three glyphs — and `unavailable` is deliberately not a cross.
 * "Nobody could be asked" is not "the answer was no", and drawing them the same
 * way would be the screen telling a lie the code is careful not to.
 */
export function CheckIcon({ status }: { status: CheckStatus }) {
  if (status === 'pass') {
    return <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-label="Passed" />;
  }
  if (status === 'fail') {
    return <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Failed" />;
  }
  return <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Not established" />;
}
