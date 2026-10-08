'use client';

import { useMutation, useQuery } from '@apollo/client/react';
import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import { CheckCircle2, CircleAlert, CircleDashed, XCircle } from 'lucide-react';
import * as React from 'react';
import type { ExternalEndpointEvidenceFieldsFragment, ExternalEndpointFieldsFragment } from '../../generated/graphql';
import { shortenDigest } from '../../lib/format';
import { errorMessageOf } from '../../lib/graphql-error';
import { DigestValue } from '../evidence/digest-value';
import { diffEvidence, isEmptyDiff } from './evidence-diff';
import {
  ADD_TRUSTED_MEASUREMENT,
  EXTERNAL_ENDPOINTS_QUERY,
  PIN_EXTERNAL_ENDPOINT_DIGEST,
  TRUSTED_MEASUREMENTS_QUERY,
} from './operations';

/** The fields both factors are read from — present on the list fragment and on the register dialog's poll. */
export type TrustFactorsEndpoint = Pick<
  ExternalEndpointFieldsFragment,
  | 'id'
  | 'name'
  | 'measurementSeen'
  | 'measurementSource'
  | 'evidenceDigestSeen'
  | 'evidenceDigestSeenHex'
  | 'pinnedEvidenceDigest'
  | 'pinnedEvidenceDigestHex'
> & {
  latestEvidence?: ExternalEndpointEvidenceFieldsFragment | null;
  pinnedEvidence?: ExternalEndpointEvidenceFieldsFragment | null;
};

export interface TrustFactorsProps {
  endpoint: TrustFactorsEndpoint;
  /** Only an admin gets the approve buttons; everyone signed in reads the factors (ruling 3). */
  isAdmin: boolean;
}

export type DigestFactorState = 'pinned' | 'not-pinned' | 'changed' | 'not-seen';

/**
 * Where the deployment factor stands. `changed` is the one that matters most: the
 * approved deployment is no longer what answers, so the endpoint fails closed
 * until an admin approves what it runs now (`digest-mismatch`).
 */
export function digestFactorState(endpoint: TrustFactorsEndpoint): DigestFactorState {
  if (!endpoint.pinnedEvidenceDigest) return 'not-pinned';
  if (!endpoint.evidenceDigestSeen) return 'not-seen';
  return endpoint.pinnedEvidenceDigest === endpoint.evidenceDigestSeen ? 'pinned' : 'changed';
}

function FactorIcon({ ok, failed }: { ok: boolean; failed?: boolean }) {
  if (ok) return <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />;
  if (failed) return <XCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />;
  return <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function digestValue(hex: string | null | undefined, canonical: string, copyLabel?: string) {
  return (
    <span className="font-mono text-xs">
      <DigestValue hex={hex ?? ''} canonical={canonical} copyLabel={copyLabel} keep={8} />
    </span>
  );
}

/**
 * Two-factor endpoint trust, one click per factor (SUP-252).
 *
 * An external endpoint is admitted only when **both** hold: its cloud's launch
 * measurement is on the trust list, and the evidence digest it publishes is the
 * one an admin pinned for it. This is the TOFU-with-approval loop: the first check
 * runs with whatever is already approved, reports both values it saw, and the
 * admin approves each from here — after which the sidecar re-attests at once.
 *
 * When a later check sees a *new* digest, the endpoint has already failed closed
 * (`digest-mismatch`); the panel shows the approved and the current deployment
 * side by side, with what changed between their evidence summaries, and offers to
 * approve the new one. Approving is a decision about software, so the diff is what
 * the button sits under.
 */
export function TrustFactors({ endpoint, isAdmin }: TrustFactorsProps) {
  const trustList = useQuery(TRUSTED_MEASUREMENTS_QUERY, { fetchPolicy: 'cache-and-network' });
  const listed = Boolean(
    endpoint.measurementSeen &&
      trustList.data?.trustedMeasurements.some((row) => row.measurement === endpoint.measurementSeen),
  );
  const [failure, setFailure] = React.useState<string | null>(null);

  const [addMeasurement, adding] = useMutation(ADD_TRUSTED_MEASUREMENT, {
    refetchQueries: [{ query: TRUSTED_MEASUREMENTS_QUERY }, { query: EXTERNAL_ENDPOINTS_QUERY }],
  });
  const [pinDigest, pinning] = useMutation(PIN_EXTERNAL_ENDPOINT_DIGEST);

  const trustMeasurement = async () => {
    if (!endpoint.measurementSeen) return;
    setFailure(null);
    try {
      await addMeasurement({
        variables: {
          input: { measurement: endpoint.measurementSeen, note: `Approved from the ${endpoint.name} dossier` },
        },
      });
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  const approveDigest = async () => {
    if (!endpoint.evidenceDigestSeen) return;
    setFailure(null);
    try {
      await pinDigest({ variables: { id: endpoint.id, input: { evidenceDigest: endpoint.evidenceDigestSeen } } });
    } catch (caught) {
      setFailure(errorMessageOf(caught));
    }
  };

  const digestState = digestFactorState(endpoint);
  const busy = adding.loading || pinning.loading;
  const registrySigned = endpoint.measurementSource === 'REGISTRY';

  return (
    <section aria-label="Trust factors" className="space-y-3" data-testid="trust-factors">
      <div>
        <h3 className="font-medium text-sm">Trust — both factors required</h3>
        <p className="text-muted-foreground text-xs">
          The cloud, by its launch measurement on the trust list, and this deployment, by the evidence digest pinned for
          it. Either one alone admits nothing.
        </p>
      </div>

      <div className="space-y-2 rounded-lg border p-3" data-testid="trust-factor-measurement">
        <div className="flex flex-wrap items-center gap-2">
          <FactorIcon ok={listed} />
          <span className="font-medium text-sm">Cloud measurement</span>
          {endpoint.measurementSeen ? (
            <Badge variant={listed ? 'success' : 'warning'}>
              {listed ? 'On the trust list' : 'Not on the trust list'}
            </Badge>
          ) : (
            <Badge variant="secondary">Not seen yet</Badge>
          )}
        </div>
        {endpoint.measurementSeen ? (
          <div className="flex flex-wrap items-center gap-2 pl-6">
            <span className="text-muted-foreground text-xs">Measurement seen</span>
            <span className="font-mono text-xs" title={endpoint.measurementSeen}>
              {shortenDigest(endpoint.measurementSeen, 8)}
            </span>
            {/*
             * Informational: a registry signature never admits on its own — the
             * trust list is the sole authority (ADR-008 §3). The badge is here so
             * the admin knows what they are vouching for when they click.
             */}
            {registrySigned ? (
              <Badge
                variant="outline"
                title="Signed in the Super Protocol registry. Informational only — only the trust list admits."
              >
                Registry-signed
              </Badge>
            ) : null}
          </div>
        ) : (
          <p className="pl-6 text-muted-foreground text-xs">No check has derived a measurement for this cloud yet.</p>
        )}
        {isAdmin && endpoint.measurementSeen && !listed && trustList.data ? (
          <div className="pl-6">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void trustMeasurement()}>
              Add to trust list
            </Button>
          </div>
        ) : null}
      </div>

      <div className="space-y-2 rounded-lg border p-3" data-testid="trust-factor-digest">
        <div className="flex flex-wrap items-center gap-2">
          <FactorIcon ok={digestState === 'pinned'} failed={digestState === 'changed'} />
          <span className="font-medium text-sm">Deployment digest</span>
          <Badge variant={digestState === 'pinned' ? 'success' : digestState === 'changed' ? 'destructive' : 'warning'}>
            {DIGEST_STATE_LABEL[digestState]}
          </Badge>
        </div>

        {digestState === 'changed' && endpoint.pinnedEvidenceDigest && endpoint.evidenceDigestSeen ? (
          <ChangedDigest endpoint={endpoint} />
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pl-6">
            <dt className="text-muted-foreground text-xs">Digest seen</dt>
            <dd>
              {endpoint.evidenceDigestSeen ? (
                digestValue(endpoint.evidenceDigestSeenHex, endpoint.evidenceDigestSeen, 'Copy the digest seen')
              ) : (
                <span className="text-muted-foreground text-xs">—</span>
              )}
            </dd>
            {endpoint.pinnedEvidenceDigest ? (
              <>
                <dt className="text-muted-foreground text-xs">Approved digest</dt>
                <dd>{digestValue(endpoint.pinnedEvidenceDigestHex, endpoint.pinnedEvidenceDigest)}</dd>
              </>
            ) : null}
          </dl>
        )}

        {isAdmin && endpoint.evidenceDigestSeen && digestState !== 'pinned' ? (
          <div className="pl-6">
            <Button
              size="sm"
              variant={digestState === 'changed' ? 'brand' : 'outline'}
              disabled={busy}
              onClick={() => void approveDigest()}
            >
              {digestState === 'changed' ? 'Approve new digest' : 'Pin this digest'}
            </Button>
          </div>
        ) : null}
      </div>

      {failure ? (
        <p role="alert" className="text-destructive text-sm">
          {failure}
        </p>
      ) : null}
    </section>
  );
}

const DIGEST_STATE_LABEL: Record<DigestFactorState, string> = {
  pinned: 'Pinned',
  'not-pinned': 'Not pinned',
  changed: 'Changed — not approved',
  'not-seen': 'Pinned, not seen yet',
};

/**
 * A redeploy nobody approved: the old and the new digest, and what changed between
 * the two evidence summaries. The endpoint is already refusing traffic; this is
 * what the admin reads before letting it back.
 */
function ChangedDigest({ endpoint }: { endpoint: TrustFactorsEndpoint }) {
  const approved = endpoint.pinnedEvidence ?? null;
  const current = endpoint.latestEvidence ?? null;
  const diff = approved && current ? diffEvidence(approved, current) : null;

  return (
    <div className="space-y-2 pl-6" data-testid="digest-change">
      <p className="flex items-start gap-1.5 text-destructive text-xs">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          The upstream now publishes a different deployment than the one approved. It fails closed — nothing routes —
          until the new digest is approved.
        </span>
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground text-xs">Approved</dt>
        <dd>{digestValue(endpoint.pinnedEvidenceDigestHex, endpoint.pinnedEvidenceDigest ?? '')}</dd>
        <dt className="text-muted-foreground text-xs">Now publishing</dt>
        <dd>{digestValue(endpoint.evidenceDigestSeenHex, endpoint.evidenceDigestSeen ?? '', 'Copy the new digest')}</dd>
      </dl>
      {diff ? (
        isEmptyDiff(diff) ? (
          <p className="text-muted-foreground text-xs">
            The two evidence summaries list the same workloads and images; the snapshot changed elsewhere.
          </p>
        ) : (
          <ul className="space-y-1 rounded-md border bg-muted/30 p-2 text-xs" aria-label="What changed">
            {diff.imagesRemoved.map((image) => (
              <DiffLine key={`-${image}`} sign="−" text={image} />
            ))}
            {diff.imagesAdded.map((image) => (
              <DiffLine key={`+${image}`} sign="+" text={image} />
            ))}
            {diff.workloadsRemoved.map((workload) => (
              <DiffLine key={`-w${workload}`} sign="−" text={`workload ${workload}`} />
            ))}
            {diff.workloadsAdded.map((workload) => (
              <DiffLine key={`+w${workload}`} sign="+" text={`workload ${workload}`} />
            ))}
            {diff.workloadsChanged.map((workload) => (
              <DiffLine key={`~w${workload}`} sign="~" text={`workload ${workload}: containers changed`} />
            ))}
          </ul>
        )
      ) : (
        <p className="text-muted-foreground text-xs">
          This router has not retrieved the evidence summary for {approved ? 'the new' : 'the approved'} digest, so it
          cannot show what changed. Compare the digests with the upstream operator before approving.
        </p>
      )}
    </div>
  );
}

function DiffLine({ sign, text }: { sign: string; text: string }) {
  return (
    <li className="flex gap-2 break-all font-mono">
      <span aria-hidden="true" className={sign === '+' ? 'text-success' : sign === '−' ? 'text-destructive' : ''}>
        {sign}
      </span>
      <span>
        <span className="sr-only">{sign === '+' ? 'added: ' : sign === '−' ? 'removed: ' : 'changed: '}</span>
        {text}
      </span>
    </li>
  );
}
