'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@confidential-router/ui/components/dialog';
import * as React from 'react';
import type { ExternalUpstreamFieldsFragment } from '../../generated/graphql';
import { formatTimestamp, shortenDigest } from '../../lib/format';
import { externalStatusPresentation } from './external-vocabulary';

export interface ExternalAttestationBadgeProps {
  upstream: ExternalUpstreamFieldsFragment;
}

/**
 * Where this router's verification of one upstream stands, and the way into what
 * that means.
 *
 * It is a sibling of `EvidenceBadge` and emphatically not a variant of it: that
 * one reports *publication* about an endpoint this deployment never verifies,
 * this one reports a *verdict* this deployment reached. They share a shape and
 * nothing else — no component, no label, no presentation map — which is what
 * keeps a reader from meeting the word "Published" about an upstream or
 * "Verified" about one of our own hostnames (ADR-008 §1).
 *
 * The accessible name carries the upstream's hostname because a catalogue has one
 * of these per external row, and the state alone would not say whose it is.
 */
export function ExternalAttestationBadge({ upstream }: ExternalAttestationBadgeProps) {
  const [open, setOpen] = React.useState(false);
  const presentation = externalStatusPresentation(upstream.status);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Attestation of ${upstream.hostname}: ${presentation.label}`}
        className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Badge variant={presentation.variant} className="cursor-pointer hover:opacity-80">
          {presentation.label}
        </Badge>
      </button>
      {open ? <ExternalAttestationDialog upstream={upstream} open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}

function ExternalAttestationDialog({
  upstream,
  open,
  onOpenChange,
}: ExternalAttestationBadgeProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const presentation = externalStatusPresentation(upstream.status);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{presentation.headline}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{upstream.hostname}</DialogDescription>
        </DialogHeader>

        <p className="max-w-prose text-muted-foreground text-sm">{presentation.note}</p>

        <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-xs sm:text-sm">
          <dt className="text-muted-foreground">Endpoint</dt>
          <dd className="min-w-0 break-all font-mono">{upstream.name}</dd>
          <dt className="text-muted-foreground">Last checked</dt>
          <dd className="min-w-0">
            {upstream.lastCheckedAt ? formatTimestamp(upstream.lastCheckedAt) : 'never — no verdict yet'}
          </dd>
          <dt className="text-muted-foreground">Measurement seen</dt>
          <dd className="min-w-0 break-all font-mono" title={upstream.measurementSeen ?? undefined}>
            {upstream.measurementSeen ? shortenDigest(`sha256:${upstream.measurementSeen}`, 8) : '—'}
          </dd>
          <dt className="text-muted-foreground">Evidence digest</dt>
          <dd className="min-w-0 break-all font-mono" title={upstream.evidenceDigestSeen ?? undefined}>
            {upstream.evidenceDigestSeen ? shortenDigest(upstream.evidenceDigestSeen, 8) : '—'}
          </dd>
        </dl>

        {/*
          Where the in-browser check lives, said rather than linked. The panel
          needs a tier-1 run over the relayed bundle and the chat screen is where
          that run already happens for the selected model; offering a second
          entry point here would mean a second gate per table row, fetching and
          verifying evidence for upstreams the reader never asked about.
        */}
        <p className="max-w-prose text-muted-foreground text-xs">
          Nothing above was checked by your browser — it is what this router reports. To verify the upstream’s signed
          evidence here in this page, and see the images and workloads it actually carries, pick this model in Chat and
          open “Inspect upstream attestation”.
        </p>
      </DialogContent>
    </Dialog>
  );
}
