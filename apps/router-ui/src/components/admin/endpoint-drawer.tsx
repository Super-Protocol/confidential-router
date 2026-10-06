'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@confidential-router/ui/components/sheet';
import type * as React from 'react';
import type { ExternalEndpointFieldsFragment } from '../../generated/graphql';
import { formatContextLength, formatPricePer1m, formatTimestamp, shortenDigest } from '../../lib/format';
import { DigestValue } from '../evidence/digest-value';
import { measurementSourceLabel, statusPresentation } from './endpoint-status';
import { EndpointTimeline } from './endpoint-timeline';
import { EvidenceSummary } from './evidence-summary';

export interface EndpointDrawerProps {
  endpoint: ExternalEndpointFieldsFragment | null;
  onOpenChange: (open: boolean) => void;
  /** Non-admin readers get the same facts without the upstream's key prefix (ruling 3). */
  isAdmin: boolean;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/**
 * Everything this router knows about one external upstream, in the order an
 * operator asks it: where it stands, what admitted it, what it is running, and
 * what has happened to it.
 *
 * A drawer rather than a page so the list keeps its place — the list is where an
 * operator compares endpoints, and the drawer is where they interrogate one.
 */
export function EndpointDrawer({ endpoint, onOpenChange, isAdmin }: EndpointDrawerProps) {
  if (!endpoint) return null;

  const presentation = statusPresentation(endpoint.status);
  const source = measurementSourceLabel(endpoint.measurementSource);

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {endpoint.name}
            <Badge variant={presentation.variant}>{presentation.label}</Badge>
          </SheetTitle>
          <SheetDescription>{presentation.detail}</SheetDescription>
        </SheetHeader>

        <div className="space-y-6 px-6 py-5">
          <section aria-label="Endpoint" className="space-y-2">
            <h3 className="font-medium text-sm">Endpoint</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
              <Field label="Base URL">
                <span className="break-all font-mono text-xs">{endpoint.baseUrl}</span>
              </Field>
              <Field label="Hostname">
                <span className="font-mono text-xs">{endpoint.hostname}</span>
              </Field>
              {isAdmin ? (
                <Field label="Upstream key">
                  <span className="font-mono text-xs">{endpoint.apiKeyPrefix ?? '—'}…</span>
                  <span className="ml-2 text-muted-foreground text-xs">stored encrypted, never returned</span>
                </Field>
              ) : null}
              <Field label="Registered">{formatTimestamp(endpoint.createdAt)}</Field>
            </dl>
          </section>

          <section aria-label="Last verdict" className="space-y-2">
            <h3 className="font-medium text-sm">Last verdict</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
              <Field label="Checked">
                {endpoint.lastCheckedAt ? formatTimestamp(endpoint.lastCheckedAt) : 'Never'}
              </Field>
              {endpoint.lastStage ? (
                <Field label="Stage">
                  <span className="font-mono text-xs">{endpoint.lastStage}</span>
                </Field>
              ) : null}
              {endpoint.lastReason ? <Field label="Reason">{endpoint.lastReason}</Field> : null}
              <Field label="Measurement seen">
                {endpoint.measurementSeen ? (
                  <>
                    <span className="font-mono text-xs" title={endpoint.measurementSeen}>
                      {shortenDigest(endpoint.measurementSeen, 8)}
                    </span>
                    {source ? <span className="ml-2 text-muted-foreground text-xs">{source}</span> : null}
                  </>
                ) : (
                  '—'
                )}
              </Field>
              <Field label="Digest seen">
                {endpoint.evidenceDigestSeen ? (
                  <span className="font-mono text-xs" title={endpoint.evidenceDigestSeen}>
                    {shortenDigest(endpoint.evidenceDigestSeen, 8)}
                  </span>
                ) : (
                  '—'
                )}
              </Field>
              <Field label="Pinned certificate">
                {endpoint.pinnedCertFingerprint ? (
                  <DigestValue
                    hex={endpoint.pinnedCertFingerprint}
                    canonical={endpoint.pinnedCertFingerprint}
                    keep={8}
                  />
                ) : (
                  'Not pinned — egress refuses'
                )}
              </Field>
            </dl>
          </section>

          <section aria-label="Models" className="space-y-2">
            <h3 className="font-medium text-sm">Models ({endpoint.models.length})</h3>
            <ul className="space-y-2">
              {endpoint.models.map((model) => (
                <li key={model.id} className="rounded-md border px-3 py-2">
                  <p className="font-medium text-sm">{model.name}</p>
                  <p className="font-mono text-muted-foreground text-xs">{model.id}</p>
                  {isAdmin && model.upstreamModel ? (
                    <p className="text-muted-foreground text-xs">
                      upstream calls it <span className="font-mono">{model.upstreamModel}</span>
                    </p>
                  ) : null}
                  <p className="mt-1 text-muted-foreground text-xs">
                    {formatContextLength(model.contextLength)} context · in{' '}
                    {formatPricePer1m(model.pricing.promptPer1m)} · out{' '}
                    {formatPricePer1m(model.pricing.completionPer1m)}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          {/* Ruling 1: present for every registered endpoint, not only on change. */}
          {endpoint.latestEvidence ? (
            <EvidenceSummary evidence={endpoint.latestEvidence} heading="Evidence summary (current)" />
          ) : (
            <section aria-label="Evidence summary (current)" className="rounded-lg border bg-muted/30 p-4">
              <h4 className="font-medium text-sm">Evidence summary (current)</h4>
              <p className="mt-1 text-muted-foreground text-sm">
                No evidence has been stored for this upstream yet. Until one is, there is nothing to show and nothing is
                routable.
              </p>
            </section>
          )}

          <section aria-label="Timeline" className="space-y-3">
            <h3 className="font-medium text-sm">Timeline</h3>
            <EndpointTimeline events={endpoint.events} />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
