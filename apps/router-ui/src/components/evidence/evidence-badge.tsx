'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import * as React from 'react';
import type { EndpointEvidenceFieldsFragment } from '../../generated/graphql';
import { EvidenceModal } from './evidence-modal';
import { evidencePresentation } from './evidence-state';

export interface EvidenceBadgeProps {
  endpoint: EndpointEvidenceFieldsFragment;
  /** Forwarded to the modal; the owning screen refetches its query. */
  onRefreshed?: () => void;
}

/**
 * The publication state of one endpoint, and the way into what it published.
 *
 * Every evidence badge in the console is this component, so the modal that
 * opens from an Overview row and the one that opens from a Models row are the
 * same modal over the same fragment. The accessible name carries the hostname
 * because a table has one of these per row and "Published" alone would not say
 * which endpoint it belongs to.
 */
export function EvidenceBadge({ endpoint, onRefreshed }: EvidenceBadgeProps) {
  const [open, setOpen] = React.useState(false);
  const presentation = evidencePresentation(endpoint.evidenceState);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Evidence for ${endpoint.hostname}: ${presentation.label}`}
        className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Badge variant={presentation.variant} className="cursor-pointer hover:opacity-80">
          {presentation.label}
        </Badge>
      </button>
      {/*
        Mounted only while open. A catalogue of eight models would otherwise
        keep eight dialogs (and eight `useMutation` subscriptions) alive to show
        none of them.
      */}
      {open ? <EvidenceModal endpoint={endpoint} open={open} onOpenChange={setOpen} onRefreshed={onRefreshed} /> : null}
    </>
  );
}
