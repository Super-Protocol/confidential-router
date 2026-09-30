'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import { CodeBlock } from '@confidential-router/ui/components/code-block';
import { CopyButton } from '@confidential-router/ui/components/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@confidential-router/ui/components/dialog';
import { Check, CircleHelp, CircleX, RefreshCw } from 'lucide-react';
import type * as React from 'react';
import { resolvedSetupScript, resolvedSetupSteps } from '../gatekeeper/setup-commands';
import type { CheckStatus, GateCheck } from './verification/evidence-gate';
import { bundleSourceNote, CHECK_LABELS, EXTENSION_TIER, GATEKEEPER_TIER, PAGE_TIER } from './verification/tiers';
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
            <ol className="space-y-3">
              {resolvedSetupSteps({ hostname, evidenceDigestHex: evidenceDigestHex }).map((step, index) => (
                <li key={step.command} className="space-y-1">
                  <p className="font-medium text-sm">
                    <span className="text-muted-foreground">{index + 1}. </span>
                    {step.title}
                  </p>
                  <CodeBlock code={step.command} copyLabel={`Copy: ${step.title}`} />
                </li>
              ))}
            </ol>
            <div className="mt-3">
              <CopyButton
                value={resolvedSetupScript({ hostname, evidenceDigestHex: evidenceDigestHex })}
                label="Copy all four commands"
                showLabel
                variant="outline"
              />
            </div>
            {evidenceDigestHex ? null : (
              <p className="mt-2 text-muted-foreground text-xs">
                This router holds no evidence digest for {hostname} yet, so the pin is left as a placeholder — take the
                value from Overview once it publishes one.
              </p>
            )}
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

function CheckRow({ check }: { check: GateCheck }) {
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
function CheckIcon({ status }: { status: CheckStatus }) {
  if (status === 'pass') {
    return <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-label="Passed" />;
  }
  if (status === 'fail') {
    return <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Failed" />;
  }
  return <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Not established" />;
}
