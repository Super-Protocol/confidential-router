'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@confidential-router/ui/components/dialog';
import type { ExternalEndpointFieldsFragment } from '../../generated/graphql';
import { DiscoveryPanel } from './discovery-panel';

export interface DiscoverModelsDialogProps {
  endpoint: ExternalEndpointFieldsFragment | null;
  onOpenChange: (open: boolean) => void;
  onDone: (endpointId: string) => void;
}

/**
 * Attest-then-list for an endpoint that is already registered — the way back
 * for a registration whose admin chose "Pick models later", and the way to
 * publish a model an upstream added since (SUP-249).
 */
export function DiscoverModelsDialog({ endpoint, onOpenChange, onDone }: DiscoverModelsDialogProps) {
  if (!endpoint) return null;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Discover models on {endpoint.name}</DialogTitle>
          <DialogDescription>
            The upstream is asked for its models only while this router’s verdict on it is in — through the attested,
            certificate-pinned egress. Models it already publishes stay as they are.
          </DialogDescription>
        </DialogHeader>
        <DiscoveryPanel endpointId={endpoint.id} endpointName={endpoint.name} onDone={onDone} />
      </DialogContent>
    </Dialog>
  );
}
