'use client';

import type { ExternalUpstreamFieldsFragment } from '../../generated/graphql';
import { InspectAttestationButton } from '../chat/attestation/inspect-button';
import { useVerification } from '../chat/verification/use-verification';

export interface ExternalInspectButtonProps {
  upstream: ExternalUpstreamFieldsFragment;
}

/**
 * The SUP-190 panel, over an external upstream's relayed evidence.
 *
 * Its own `useVerification` and deliberately not the chat's: the two answer
 * different questions and must not be able to be mistaken for one another. The
 * chat's gate is about the channel the browser opened — this router — and it is
 * what unlocks the composer. This one is about a document another deployment
 * published, read through the relay, verified here, and it unlocks nothing. Two
 * hooks is what keeps the second from ever gating a message or the first from
 * ever drawing the upstream's graph.
 *
 * It runs on mount rather than on the first press, which costs one relay fetch
 * and one signature check per external model selected. That is the right trade:
 * the panel's props are a settled `VerificationState`, and making the reader wait
 * for a fetch *after* pressing a button labelled "Inspect" would be the slower
 * surface for the sake of a request the page can afford. The panel's own chunk is
 * still only fetched on the press (`inspect-button.tsx`).
 */
export function ExternalInspectButton({ upstream }: ExternalInspectButtonProps) {
  const verification = useVerification({
    hostname: upstream.hostname,
    endpointName: upstream.name,
    kind: 'external',
  });

  return (
    <InspectAttestationButton
      verification={verification}
      hostname={upstream.hostname}
      endpointKind="external"
      // Nobody declared what another deployment runs, and v1 does not ask an
      // operator to: null is "nothing was declared", which the graph already
      // renders as the signed images without a comparison (ADR-008 §7).
      teeLabel={null}
      declaredImages={null}
    />
  );
}
