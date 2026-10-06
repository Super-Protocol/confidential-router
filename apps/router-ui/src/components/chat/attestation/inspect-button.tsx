'use client';

import { Button } from '@confidential-router/ui/components/button';
import { ScanSearch } from 'lucide-react';
import * as React from 'react';
import type { EndpointKind } from '../verification/evidence-gate';
import type { VerificationState } from '../verification/use-verification';
import type { DeclaredImage } from './graph-model';

/**
 * The inspector, as its own chunk.
 *
 * `React.lazy` over a dynamic `import()` is what keeps react-flow and everything
 * under `attestation/` out of the chat screen's bundle: the module graph of this
 * file reaches the inspector only through a call expression, so the bundler emits
 * it as a separate chunk and the browser fetches it when someone presses the
 * button. A reader who never opens the panel pays nothing for it, which was the
 * explicit condition on this work.
 *
 * `code-split.spec.ts` asserts the property rather than trusting this comment.
 */
const AttestationInspector = React.lazy(() => import('./inspector'));

export interface InspectAttestationButtonProps {
  verification: VerificationState;
  hostname: string;
  teeLabel: string | null;
  declaredImages: readonly DeclaredImage[] | null;
  /**
   * Whose endpoint the panel is about. `external` changes the button's label and
   * the panel's provenance, and nothing about how the bundle is verified — the
   * same tier-1 run over the same verifier, which is the point of rendering an
   * upstream's evidence "the same way" (ADR-008 §7).
   */
  endpointKind?: EndpointKind;
}

export function InspectAttestationButton({
  verification,
  hostname,
  teeLabel,
  declaredImages,
  endpointKind = 'own',
}: InspectAttestationButtonProps) {
  const [open, setOpen] = React.useState(false);
  /*
   * Once opened, the chunk stays mounted so closing and reopening is instant and
   * the dialog's own exit animation has something to animate. `open` still drives
   * the dialog; this only decides whether the lazy component exists at all.
   */
  const [requested, setRequested] = React.useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setRequested(true);
          setOpen(true);
        }}
      >
        <ScanSearch aria-hidden="true" />
        {endpointKind === 'external' ? 'Inspect upstream attestation' : 'Inspect attestation'}
      </Button>
      {requested ? (
        <React.Suspense fallback={null}>
          <AttestationInspector
            open={open}
            onOpenChange={setOpen}
            verification={verification}
            hostname={hostname}
            teeLabel={teeLabel}
            declaredImages={declaredImages}
            endpointKind={endpointKind}
          />
        </React.Suspense>
      ) : null}
    </>
  );
}
