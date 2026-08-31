import type { EvidenceState } from '../../generated/graphql';

export interface EvidencePresentation {
  /** Badge text in a table row. */
  label: string;
  /** `Badge` variant carrying the tone. */
  variant: 'success' | 'warning' | 'secondary';
  /** Headline of the evidence modal. */
  headline: string;
  /** The one line under the headline. */
  note: string;
}

/**
 * How the three publication states read.
 *
 * ADR-002: the router never learns whether anyone verified an endpoint, so
 * nothing here may say *verified*, *trusted* or *valid*. Every string states
 * what the platform published and leaves the verdict to the viewer's
 * gatekeeper. `STALE` is the prototype's "signing key rotating" screen: a
 * bundle exists but is outside the freshness window, which is what a viewer
 * sees while the platform re-issues a quote.
 */
export const EVIDENCE_PRESENTATION: Record<EvidenceState, EvidencePresentation> = {
  PUBLISHED: {
    label: 'Published',
    variant: 'success',
    headline: 'Evidence published',
    note: 'The platform publishes a current bundle for this hostname. What follows is what it published — checking it is your gatekeeper’s job, not this console’s.',
  },
  STALE: {
    label: 'Stale',
    variant: 'warning',
    headline: 'Signing key rotating',
    note: 'The last bundle published for this hostname is outside the freshness window — a fresh quote is being issued. Verify again shortly.',
  },
  NOT_PUBLISHED: {
    label: 'Not published',
    variant: 'secondary',
    headline: 'Nothing published',
    note: 'The platform publishes no evidence bundle for this hostname right now. That is an absence of evidence, not a statement about the endpoint.',
  },
};

export function evidencePresentation(state: EvidenceState): EvidencePresentation {
  return EVIDENCE_PRESENTATION[state];
}
