import type { ExternalEndpointEventKind, ExternalEndpointStatus, MeasurementSource } from '../../generated/graphql';
import { EXTERNAL_VERDICT_LABELS } from '../external/external-vocabulary';

/** The `Badge` tones this module uses, named rather than inferred — `class-variance-authority` is the UI library's own dependency, not router-ui's. */
type BadgeVariant = 'success' | 'warning' | 'destructive' | 'secondary' | 'outline';

export interface StatusPresentation {
  label: string;
  variant: BadgeVariant;
  /** One sentence under the chip, so a status never has to be looked up. */
  detail: string;
}

/**
 * The external-endpoint vocabulary, in one place.
 *
 * ADR-008 §1 makes this wording a contract, not a style choice: the router's own
 * endpoints are described by publication (*published / stale / not published*)
 * because it never verifies itself, and an external upstream is described by a
 * verdict that **names the verifying party**. "Verified" alone is the word this
 * console is not allowed to use here — a reader would not know who did the
 * verifying, and the whole point of ADR-002 is that it matters.
 */
const STATUS_PRESENTATION: Record<ExternalEndpointStatus, StatusPresentation> = {
  PENDING: {
    label: 'Pending',
    variant: 'secondary',
    detail:
      'No verdict yet, or its deployment is awaiting approval (digest-not-pinned). It serves nothing until both trust factors hold.',
  },
  VERIFIED_BY_THIS_ROUTER: {
    label: EXTERNAL_VERDICT_LABELS.VERIFIED_BY_THIS_ROUTER,
    variant: 'success',
    detail:
      'Evidence verified, cloud measurement on the trust list, deployment digest pinned, certificate pinned. Its models are routable.',
  },
  DENIED_BY_THIS_ROUTER: {
    label: EXTERNAL_VERDICT_LABELS.DENIED_BY_THIS_ROUTER,
    variant: 'destructive',
    detail: 'The last check refused it. Its models are out of /v1/models and routing is refused.',
  },
  DISABLED: {
    label: 'Disabled',
    variant: 'outline',
    detail: 'Switched off by an operator. Not rendered into the egress config at all.',
  },
};

export function statusPresentation(status: ExternalEndpointStatus): StatusPresentation {
  return STATUS_PRESENTATION[status];
}

/** Every chip the screen can show, in the order the list sorts them. */
export const STATUS_ORDER: ExternalEndpointStatus[] = [
  'DENIED_BY_THIS_ROUTER',
  'PENDING',
  'VERIFIED_BY_THIS_ROUTER',
  'DISABLED',
];

export interface EventPresentation {
  label: string;
  variant: BadgeVariant;
}

/**
 * The timeline's labels. `DIGEST_CHANGED` and `MEASUREMENT_CHANGED` are warnings
 * rather than neutral notes on purpose: under two-factor trust (SUP-252) a digest
 * change fails the endpoint closed until an admin approves it, so it is the one
 * thing in here an operator has to read. `DIGEST_PINNED` is that approval.
 */
const EVENT_PRESENTATION: Record<ExternalEndpointEventKind, EventPresentation> = {
  REGISTERED: { label: 'Registered', variant: 'secondary' },
  VERIFIED_BY_THIS_ROUTER: { label: EXTERNAL_VERDICT_LABELS.VERIFIED_BY_THIS_ROUTER, variant: 'success' },
  DENIED_BY_THIS_ROUTER: { label: EXTERNAL_VERDICT_LABELS.DENIED_BY_THIS_ROUTER, variant: 'destructive' },
  DIGEST_CHANGED: { label: 'Deployment digest changed', variant: 'warning' },
  DIGEST_PINNED: { label: 'Deployment digest pinned', variant: 'secondary' },
  MEASUREMENT_CHANGED: { label: 'Measurement changed', variant: 'warning' },
  DISABLED: { label: 'Disabled', variant: 'outline' },
  KEY_ROTATED: { label: 'Key rotated', variant: 'secondary' },
};

export function eventPresentation(kind: ExternalEndpointEventKind): EventPresentation {
  return EVENT_PRESENTATION[kind];
}

/**
 * An event that carries an evidence summary is one where the operator has to be
 * able to see what the upstream was running — registration and every change to
 * it, which is SUP-221 ruling 1 restated as a predicate.
 */
export function showsEvidenceSummary(kind: ExternalEndpointEventKind): boolean {
  return (
    kind === 'REGISTERED' || kind === 'DIGEST_CHANGED' || kind === 'DIGEST_PINNED' || kind === 'MEASUREMENT_CHANGED'
  );
}

const MEASUREMENT_SOURCE_LABEL: Record<MeasurementSource, string> = {
  REGISTRY: 'registry-signed',
  OPERATOR_PINNED: 'operator-pinned',
};

/**
 * Which anchor vouched for the measurement — display state only. Under ADR-008
 * §3 a registry signature does **not** admit on its own: the admin list is the
 * sole authority, and this label is reported next to it precisely so nobody
 * reads "registry-signed" as "therefore allowed".
 */
export function measurementSourceLabel(source: MeasurementSource | null | undefined): string | null {
  return source ? MEASUREMENT_SOURCE_LABEL[source] : null;
}
