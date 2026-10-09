'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@confidential-router/ui/components/dialog';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import type * as React from 'react';
import { GatekeeperSetupBlock } from '../gatekeeper/setup-block';
import { CheckRow } from './verification/check-row';
import {
  bundleSourceNote,
  EXTENSION_TIER,
  GATEKEEPER_TIER,
  gatekeeperDivergenceNote,
  PAGE_TIER,
} from './verification/tiers';
import type { VerificationState } from './verification/use-verification';

export interface VerificationPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  verification: VerificationState;
  hostname: string;
  /** From the router's own snapshot, for the Gatekeeper commands. */
  evidenceDigestHex: string | null;
  /** Where the extension is published; absent hides the install affordance. */
  extensionUrl?: string;
}

/**
 * "What has actually been checked, and by whom."
 *
 * The one thing this screen exists to prevent is a reader coming away thinking a
 * green badge in a web page is the same as an attested channel. So it shows all
 * three tiers at once — including the one that is not running — and states the
 * limit of each in the same breath as its result. Every string comes from
 * `verification/tiers.ts`; none is written here.
 */
export function VerificationPanel({
  open,
  onOpenChange,
  verification,
  hostname,
  evidenceDigestHex,
  extensionUrl,
}: VerificationPanelProps) {
  const { gate, extension, pageState, extensionState } = verification;
  const page = PAGE_TIER[pageState === 'unavailable' ? 'pending' : pageState];
  const extensionTier = EXTENSION_TIER[extensionState];
  const divergence = gatekeeperDivergenceNote(gate);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>What has been verified</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{hostname}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <Tier title="1 — This page" badge={page.label} variant={page.variant} caveat={page.caveat}>
            {gate ? (
              <>
                <ul className="space-y-2">
                  {gate.checks.map((check) => (
                    <CheckRow key={check.id} check={check} />
                  ))}
                </ul>
                {gate.evidence ? (
                  <p className="mt-3 text-muted-foreground text-xs">{bundleSourceNote(gate.evidence.source)}</p>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground text-sm" role="status">
                Checking…
              </p>
            )}
          </Tier>

          <Tier
            title="2 — The browser extension"
            badge={extensionTier.label}
            variant={extensionTier.variant}
            caveat={extensionTier.caveat}
          >
            {extension?.status === 'verified' || extension?.status === 'refused' ? (
              <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-1 text-xs sm:text-sm">
                {extension.verdict.rootName ? (
                  <>
                    <dt className="text-muted-foreground">Matched root</dt>
                    <dd className="min-w-0 break-words">{extension.verdict.rootName}</dd>
                  </>
                ) : null}
                {extension.verdict.channelBinding ? (
                  <>
                    <dt className="text-muted-foreground">Channel binding</dt>
                    <dd className="font-mono">{extension.verdict.channelBinding}</dd>
                  </>
                ) : null}
                {extension.verdict.reason ? (
                  <>
                    <dt className="text-muted-foreground">Reason</dt>
                    <dd className="min-w-0 break-words">{extension.verdict.reason}</dd>
                  </>
                ) : null}
              </dl>
            ) : extensionUrl && extensionState === 'unavailable' ? (
              <Button asChild variant="outline" size="sm">
                <a href={extensionUrl} target="_blank" rel="noreferrer noopener">
                  Install the extension
                </a>
              </Button>
            ) : null}
          </Tier>

          <Tier
            title="3 — Gatekeeper, on your machine"
            badge={GATEKEEPER_TIER.label}
            variant={GATEKEEPER_TIER.variant}
            caveat={GATEKEEPER_TIER.caveat}
          >
            {divergence ? (
              <p
                className="mb-3 flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
                role="status"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                <span className="min-w-0">{divergence}</span>
              </p>
            ) : null}
            {/*
              The same block the API Keys page's "How to connect" shows, from the
              same data: a reader who finds the commands here and again there must
              not find two different sequences (SUP-193).
            */}
            <GatekeeperSetupBlock upstream={`https://${hostname}`} evidenceDigestHex={evidenceDigestHex} />
          </Tier>
        </div>

        <DialogFooter className="flex-row flex-wrap items-center gap-2 border-t px-6 py-4 sm:justify-start">
          <Button variant="outline" size="sm" onClick={verification.recheck}>
            <RefreshCw aria-hidden="true" />
            Check again
          </Button>
          <Button variant="ghost" size="sm" className="sm:ml-auto" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Tier({
  title,
  badge,
  variant,
  caveat,
  children,
}: {
  title: string;
  badge: string;
  variant: 'success' | 'warning' | 'secondary' | 'destructive';
  caveat: string;
  children?: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-sm">{title}</h3>
        <Badge variant={variant}>{badge}</Badge>
      </div>
      {/*
        The caveat sits above the detail, not below it: it is the sentence that
        decides what the result means, and a reader who stops after the first
        line has to have read it.
      */}
      <p className="mb-3 max-w-prose text-muted-foreground text-sm">{caveat}</p>
      {children}
    </section>
  );
}
