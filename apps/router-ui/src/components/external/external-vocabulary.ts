import type { ExternalEndpointStatus } from '../../generated/graphql';

/**
 * Every word the console says about an external upstream, in one file — and
 * deliberately not the file that holds the words for our own endpoints.
 *
 * ## Why there are two vocabularies at all
 *
 * ADR-002 keeps *published / stale / not published* for the router's own
 * endpoints because the router never verifies itself: the only honest statement
 * is what the platform published, and the verdict belongs to the viewer's
 * gatekeeper. Toward an external upstream the position is exactly inverted —
 * there **is** a verifying party and it is this router — so every value here
 * names it: *verified by this router*, *denied by this router* (ADR-008 §1).
 *
 * ## Why they are two files
 *
 * So that "the two vocabularies never mix in one component" is a property of the
 * module graph rather than a reviewer's vigilance. A component that imported both
 * maps would be one `?:` away from a badge that says *Published* about a
 * deployment this router verified, or *Verified* about one it only watched —
 * which is the single most expensive sentence this product could get wrong.
 * `external-vocabulary.spec.ts` asserts the two label sets are disjoint and that
 * neither borrows the other's words.
 *
 * ## Why no value is a bare "verified"
 *
 * A bare *verified* with no subject is the claim the product is not entitled to
 * make anywhere: it reads as "verified, full stop", which only the viewer's own
 * gatekeeper can say. The qualifier is part of the label, not a footnote beside
 * it.
 */

/**
 * The two strings ADR-008 §1 makes a contract, and the one place they are spelled.
 *
 * Every other label in this product is copy. These two are the claim: *who*
 * verified, and *who* denied. A screen that dropped the qualifier would be saying
 * the one sentence only the viewer's own gatekeeper may say, and a screen that
 * reworded it would be making a second claim that reads like the first.
 *
 * Shared across surfaces rather than duplicated per screen, because this
 * repository has already paid once for two files that were each supposed to be
 * the single source of one thing (SUP-235). The admin section's chips, its
 * verdict timeline and the public catalogue's badge all read from here; what each
 * surface keeps to itself is tone and supporting copy, which legitimately differ
 * — an operator who curated the trust list and a visitor comparing prices are not
 * owed the same emphasis. `external-vocabulary.spec.ts` asserts no other module
 * spells either string.
 */
export const EXTERNAL_VERDICT_LABELS = {
  VERIFIED_BY_THIS_ROUTER: 'Verified by this router',
  DENIED_BY_THIS_ROUTER: 'Denied by this router',
} as const;

export interface ExternalStatusPresentation {
  /** Badge text in a table row. Always names this router. */
  label: string;
  /** `Badge` variant carrying the tone. */
  variant: 'success' | 'warning' | 'secondary' | 'destructive';
  /** Headline of the detail dialog. */
  headline: string;
  /** The paragraph under the headline — what the state means and what it does not. */
  note: string;
}

export const EXTERNAL_STATUS_PRESENTATION: Record<ExternalEndpointStatus, ExternalStatusPresentation> = {
  VERIFIED_BY_THIS_ROUTER: {
    label: EXTERNAL_VERDICT_LABELS.VERIFIED_BY_THIS_ROUTER,
    /*
     * Green: this is the good state, and a reader scanning a table should see it
     * as one (SUP-255). The label still carries the qualifier — the colour says
     * "all checks passed", the words say who ran them — and the dialog's note
     * says what a self-report by the router is and is not. Amber is kept for
     * states that need the reader's attention, not for a pass.
     */
    variant: 'success',
    headline: 'This router verified this upstream',
    note: 'This router fetched the upstream’s signed evidence, checked it, found the cloud’s measurement on its trust list and the deployment’s evidence digest equal to the one its operator approved, and pinned the TLS certificate the evidence names. That is a verdict reached by this deployment, not by you — inspect the relayed evidence to see what was approved.',
  },
  DENIED_BY_THIS_ROUTER: {
    label: EXTERNAL_VERDICT_LABELS.DENIED_BY_THIS_ROUTER,
    variant: 'destructive',
    headline: 'This router refuses this upstream',
    note: 'The last check failed, so nothing is proxied here: the model is listed and unavailable. Fail-closed is the rule rather than a retry policy — a request would be refused at two independent places, the catalogue and the egress.',
  },
  PENDING: {
    label: 'Awaiting a verdict',
    variant: 'secondary',
    headline: 'No verdict yet',
    note: 'Registered, and not yet admitted — not checked yet, or checked and waiting for its operator to approve the deployment. Every upstream starts here and restarts here, because a verdict is never persisted as trust. It serves nothing until a check admits it.',
  },
  DISABLED: {
    label: 'Switched off',
    variant: 'secondary',
    headline: 'Switched off by the operator',
    note: 'An operator took this upstream out of service. That is a switch rather than a verdict: nothing here says the upstream failed a check.',
  },
};

export function externalStatusPresentation(status: ExternalEndpointStatus): ExternalStatusPresentation {
  return EXTERNAL_STATUS_PRESENTATION[status];
}

/**
 * There is deliberately no origin badge in this vocabulary.
 *
 * The Models page and the chat picker used to tag an external row "External".
 * That is the serving topology — which deployment answers — and a user of the
 * router has no use for it: every model is reached through this router, every
 * message is billed the same way, and what the user is owed is the verdict
 * badge beside the row, not where the weights live. The distinction stays in the
 * admin section, which is about endpoints rather than models (SUP-255).
 */

/** Availability, in words, for a reader who is shown no verdict at all. */
export const EXTERNAL_AVAILABILITY = {
  available: 'Available',
  unavailable: 'Unavailable',
} as const;
