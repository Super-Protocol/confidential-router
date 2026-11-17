'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@confidential-router/ui/components/popover';
import { Info } from 'lucide-react';
import * as React from 'react';
import { badgeTier } from './verification/tiers';
import type { VerificationState } from './verification/use-verification';
import { VerificationPanel } from './verification-panel';

export interface VerificationBadgeProps {
  verification: VerificationState;
  hostname: string;
  evidenceDigestHex: string | null;
  extensionUrl?: string;
}

/**
 * The chat's one claim about verification, and the way into the whole story.
 *
 * The badge carries the tier, and the sentence behind it carries the tier's
 * limit — never one without the other, which is the rule the feature turns on. A
 * badge that said "Verified" on its own would be the single most misleading
 * string the product could ship.
 *
 * "Behind" rather than "beside" since SUP-262: the caveat is four lines, and
 * four lines wedged between a pill and two buttons was the chat toolbar Denis
 * called scattered. So the pill is the trigger, its accessible name says there
 * is something to read, and one press shows the caveat in the tier's own words
 * with the full report — every check, every tier, the Gatekeeper commands — one
 * press further. The words are `verification/tiers.ts`'s; the pill's tone is the
 * tier's (`warning` for a self-report, `success` only for the extension), so the
 * distinction from "Verified by this router" survives the move.
 */
export function VerificationBadge({ verification, hostname, evidenceDigestHex, extensionUrl }: VerificationBadgeProps) {
  const [caveatOpen, setCaveatOpen] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const tier = badgeTier(verification.pageState, verification.extensionState);

  return (
    <>
      <Popover open={caveatOpen} onOpenChange={setCaveatOpen}>
        <PopoverTrigger
          aria-label={`${tier.label}. What this means`}
          className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Badge variant={tier.variant} className="h-8 cursor-pointer gap-1.5 px-2.5 hover:opacity-90">
            {tier.label}
            <Info aria-hidden="true" className="size-3.5 opacity-70" />
          </Badge>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-96 space-y-3">
          <p className="text-muted-foreground text-xs">{tier.caveat}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setCaveatOpen(false);
              setPanelOpen(true);
            }}
          >
            What has been verified?
          </Button>
        </PopoverContent>
      </Popover>
      {panelOpen ? (
        <VerificationPanel
          open={panelOpen}
          onOpenChange={setPanelOpen}
          verification={verification}
          hostname={hostname}
          evidenceDigestHex={evidenceDigestHex}
          extensionUrl={extensionUrl}
        />
      ) : null}
    </>
  );
}
