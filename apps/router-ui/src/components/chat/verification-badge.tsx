'use client';

import { Badge } from '@confidential-router/ui/components/badge';
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
 * The badge carries the tier, and the sentence beside it carries the tier's
 * limit — never one without the other, which is the rule the feature turns on. A
 * badge that said "Verified" on its own would be the single most misleading
 * string the product could ship.
 */
export function VerificationBadge({ verification, hostname, evidenceDigestHex, extensionUrl }: VerificationBadgeProps) {
  const [open, setOpen] = React.useState(false);
  const tier = badgeTier(verification.pageState, verification.extensionState);

  return (
    <>
      <div className="flex flex-wrap items-start gap-x-2.5 gap-y-1">
        <Badge variant={tier.variant}>{tier.label}</Badge>
        <p className="min-w-0 flex-1 text-muted-foreground text-xs">
          {tier.caveat}{' '}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            What has been verified?
          </button>
        </p>
      </div>
      {open ? (
        <VerificationPanel
          open={open}
          onOpenChange={setOpen}
          verification={verification}
          hostname={hostname}
          evidenceDigestHex={evidenceDigestHex}
          extensionUrl={extensionUrl}
        />
      ) : null}
    </>
  );
}
