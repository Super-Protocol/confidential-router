'use client';

import { useMutation } from '@apollo/client/react';
import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import { CopyButton } from '@confidential-router/ui/components/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@confidential-router/ui/components/dialog';
import { Loader2, RefreshCw } from 'lucide-react';
import * as React from 'react';
import type { EndpointEvidenceFieldsFragment, EvidenceSnapshotFieldsFragment } from '../../generated/graphql';
import { formatQuoteAge, formatTimestamp } from '../../lib/format';
import { DigestValue } from './digest-value';
import { evidencePresentation } from './evidence-state';
import { REFRESH_EVIDENCE } from './queries';

export interface EvidenceModalProps {
  endpoint: EndpointEvidenceFieldsFragment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called after a successful re-poll. The screen that owns the query refetches,
   * because a new bundle can also change the endpoint's `evidenceState`, which
   * this mutation does not return.
   */
  onRefreshed?: () => void;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">{children}</h3>;
}

/** One `label: value` row. `mono` for anything a viewer compares character by character. */
function Field({ label, children, mono = true }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'min-w-0 break-all font-mono' : 'min-w-0'}>{children}</dd>
    </>
  );
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2 text-xs sm:text-sm">{children}</dl>;
}

/**
 * What one endpoint published, in the shape the prototype's evidence modal used.
 *
 * The one rule the whole screen obeys (ADR-002): it reports what the platform
 * published and never whether it checked out. There is no verdict, no tick, no
 * "verified" — the chain ends at a named root and the viewer's gatekeeper is
 * what decides whether that root is one they trust.
 */
export function EvidenceModal({ endpoint, open, onOpenChange, onRefreshed }: EvidenceModalProps) {
  // The mutation's own answer, kept so the details update the moment it lands
  // rather than after the parent's refetch round-trips. `null` inside the box is
  // a real answer — "the platform has nothing published" — and is why this is a
  // box and not a bare snapshot.
  const [refreshed, setRefreshed] = React.useState<{ snapshot: EvidenceSnapshotFieldsFragment | null } | null>(null);

  const [refresh, { loading: refreshing, error: refreshError, reset }] = useMutation(REFRESH_EVIDENCE, {
    onCompleted: (data) => {
      setRefreshed({ snapshot: data.refreshEvidence ?? null });
      onRefreshed?.();
    },
  });

  // A modal reopened on another endpoint must not show the previous one's quote.
  React.useEffect(() => {
    if (!open) {
      setRefreshed(null);
      reset();
    }
  }, [open, reset]);

  const snapshot = refreshed ? refreshed.snapshot : endpoint.latestEvidence;
  const presentation = evidencePresentation(endpoint.evidenceState);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>{presentation.headline}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{endpoint.hostname}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 px-4 py-3">
            <Badge variant={presentation.variant}>{presentation.label}</Badge>
            <p className="min-w-0 flex-1 text-muted-foreground text-sm">{presentation.note}</p>
          </div>

          {refreshError ? (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
              Could not fetch a fresh quote. The endpoint may be unreachable; try again in a moment.
            </p>
          ) : null}

          {snapshot ? (
            <EvidenceDetails endpoint={endpoint} snapshot={snapshot} />
          ) : (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
              There is no published bundle to show for this endpoint yet.
            </p>
          )}
        </div>

        <DialogFooter className="flex-row flex-wrap items-center gap-2 border-t px-6 py-4 sm:justify-start">
          <CopyButton
            value={snapshot?.jws ?? ''}
            label="Copy evidence JWS"
            variant="default"
            showLabel
            disabled={!snapshot}
            title={snapshot ? undefined : 'Nothing has been published for this endpoint'}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => {
              void refresh({ variables: { endpointId: endpoint.id } });
            }}
          >
            {refreshing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            Fetch fresh quote
          </Button>
          <span role="status" aria-live="polite" className="sr-only">
            {refreshing ? 'Fetching a fresh quote' : ''}
          </span>
          <Button variant="ghost" size="sm" className="sm:ml-auto" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EvidenceDetails({
  endpoint,
  snapshot,
}: {
  endpoint: EndpointEvidenceFieldsFragment;
  snapshot: EvidenceSnapshotFieldsFragment;
}) {
  const root = snapshot.chain.find((cert) => cert.isRoot) ?? snapshot.chain.at(-1);

  return (
    <>
      <section>
        <SectionTitle>Enclave</SectionTitle>
        <FieldGrid>
          <Field label="Platform" mono={false}>
            {endpoint.tee}
            <span className="text-muted-foreground"> · operator-declared label</span>
          </Field>
          {/*
            The shipped schema has no TCB SVN field. `quoteFormat` is the
            platform/TCB generation the bundle was produced under
            (`intel-tdx-quote-v5`); anything finer the producer published shows
            up under Measurements.
          */}
          <Field label="Quote format">{snapshot.quoteFormat ?? 'not stated'}</Field>
          <Field label="Image">
            {snapshot.containerImages.length > 0 ? (
              <ul className="space-y-1">
                {snapshot.containerImages.map((image) => (
                  <li key={image}>{image}</li>
                ))}
              </ul>
            ) : (
              'none published'
            )}
          </Field>
          <Field label="Quote age">
            {formatQuoteAge(snapshot.quoteAgeSeconds)}
            <span className="text-muted-foreground"> · issued {formatTimestamp(snapshot.issuedAt)}</span>
          </Field>
          <Field label="Retrieved">{formatTimestamp(snapshot.fetchedAt)}</Field>
          <Field label="Evidence digest">
            <DigestValue
              hex={snapshot.evidenceDigestHex}
              canonical={snapshot.evidenceDigest}
              copyLabel={`Copy evidence digest for ${endpoint.hostname}`}
              keep={10}
            />
          </Field>
        </FieldGrid>
      </section>

      {snapshot.measurements.length > 0 ? (
        <section className="border-t pt-5">
          <SectionTitle>Measurements</SectionTitle>
          <dl className="space-y-2 text-xs sm:text-sm">
            {snapshot.measurements.map((measurement) => (
              <div key={measurement.name} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <dt className="w-16 shrink-0 font-mono text-muted-foreground">{measurement.name}</dt>
                <dd className="min-w-0 flex-1 break-all font-mono">{measurement.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section className="border-t pt-5">
        <SectionTitle>Certificate chain</SectionTitle>
        <ol className="space-y-2 text-xs sm:text-sm">
          {snapshot.chain.map((cert, index) => (
            <li key={cert.fingerprint} className="flex gap-3">
              <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full border-2 border-brand" />
              <div className="min-w-0">
                <p className="font-mono">
                  <span className="text-muted-foreground">
                    {cert.isRoot ? 'root' : index === 0 ? 'leaf' : 'intermediate'} ·{' '}
                  </span>
                  {cert.subject}
                </p>
                <p className="break-all font-mono text-muted-foreground text-xs">
                  <DigestValue hex={cert.fingerprintHex} canonical={cert.fingerprint} keep={10} /> · expires{' '}
                  {formatTimestamp(cert.notAfter)}
                </p>
              </div>
            </li>
          ))}
        </ol>
        {/*
          Names the root the chain terminates at and stops there. Whether that
          root is trusted is a fact about the viewer's trust store, which this
          console has never seen.
        */}
        <p className="mt-3 text-muted-foreground text-xs">
          {root
            ? `The published chain terminates at ${root.subject}. Your gatekeeper decides whether that root is one you trust.`
            : 'The bundle published no certificate chain.'}
        </p>
        <div className="mt-4">
          <FieldGrid>
            <Field label="certFingerprint">
              <DigestValue
                hex={snapshot.certFingerprintHex}
                canonical={snapshot.certFingerprint}
                copyLabel={`Copy TLS certificate fingerprint for ${endpoint.hostname}`}
                keep={10}
              />
            </Field>
          </FieldGrid>
          <p className="mt-2 text-muted-foreground text-xs">
            The TLS leaf the bundle asserts. A gatekeeper compares it against the certificate it actually observes on
            the connection.
          </p>
        </div>
      </section>
    </>
  );
}
