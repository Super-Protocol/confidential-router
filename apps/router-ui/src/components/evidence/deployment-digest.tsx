'use client';

import { useQuery } from '@apollo/client/react';
import { Badge } from '@confidential-router/ui/components/badge';
import { CopyButton } from '@confidential-router/ui/components/copy-button';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { graphql } from '../../generated';
import { formatDigest } from '../../lib/format';
import { evidencePresentation } from './evidence-state';

/**
 * This deployment's own endpoint and the digest it currently publishes.
 *
 * `routerEndpoint` rather than a row of `endpoints`: the console cannot tell
 * which hostname of the list *is* the deployment the browser is talking to, and
 * that is the only one a reader's `--from-upstream` report can be compared
 * against. It is the same field the chat's gate runs on, and it is public — so
 * this block paints for an anonymous reader too, like the quick-start it sits in.
 */
export const DEPLOYMENT_DIGEST_QUERY = graphql(`
  query DeploymentDigest {
    routerEndpoint {
      id
      hostname
      evidenceState
      latestEvidence {
        id
        issuedAt
        tee
        evidenceDigest
        evidenceDigestHex
      }
    }
  }
`);

export interface DeploymentDigestProps {
  /** Heading of the block; the two screens that show it introduce it differently. */
  title?: string;
}

/**
 * The evidence digest of the deployment you are signed in to, in full.
 *
 * Every other digest surface in the console truncates — a table cell and a modal
 * field cannot carry 64 hex characters, so they show both ends and put the whole
 * value in the clipboard and the tooltip. That is fine for recognising a digest
 * and useless for the one decision the pinning model rests on: `gatekeeper
 * endpoint trust add --from-upstream` prints all 64 characters and asks a y/n,
 * and the docs tell the reader to compare it against what the console shows. A
 * 12-character comparison is not that comparison (SUP-541).
 *
 * So this block prints the complete `sha256:<64 hex>`, wrapped, in the same
 * spelling the gatekeeper prints and its config file records (SUP-115) — a value
 * a reader can run their eye along character by character, or copy and diff.
 *
 * It renders nothing at all only when the router cannot name its own endpoint;
 * a deployment that publishes no current bundle says so, because "no digest
 * here" and "a digest you did not find" are different answers to the reader
 * standing at that y/n.
 */
export function DeploymentDigest({ title = 'This deployment’s evidence digest' }: DeploymentDigestProps) {
  const { data, loading } = useQuery(DEPLOYMENT_DIGEST_QUERY, { fetchPolicy: 'cache-and-network' });

  if (!data) {
    return loading ? <Skeleton className="h-28 rounded-xl" aria-hidden="true" /> : null;
  }

  const endpoint = data.routerEndpoint;
  if (!endpoint) {
    return null;
  }

  const snapshot = endpoint.latestEvidence;
  const presentation = evidencePresentation(endpoint.evidenceState);

  return (
    <section
      aria-labelledby="deployment-digest-heading"
      data-testid="deployment-digest"
      className="rounded-xl border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="deployment-digest-heading" className="font-semibold text-sm">
          {title}
        </h3>
        <Badge variant={presentation.variant}>{presentation.label}</Badge>
      </div>

      <p className="mt-1 font-mono text-muted-foreground text-xs">
        {endpoint.hostname}
        {snapshot?.tee ? ` · ${snapshot.tee}` : ''}
      </p>

      {snapshot ? (
        <>
          <div className="mt-3 flex items-start gap-2 rounded-lg border bg-muted/40 p-3">
            {/*
              `break-all`, not truncation: the point of this block is that the
              whole value is on the page. `select-all` so one click takes it for
              a reader who would rather diff it than read it.
            */}
            <code data-testid="deployment-digest-value" className="min-w-0 select-all break-all font-mono text-xs">
              {formatDigest(snapshot.evidenceDigestHex, snapshot.evidenceDigest)}
            </code>
            <CopyButton
              value={formatDigest(snapshot.evidenceDigestHex, snapshot.evidenceDigest)}
              label={`Copy the evidence digest of ${endpoint.hostname}`}
              className="-my-1 shrink-0"
            />
          </div>
          <p className="mt-2 max-w-prose text-muted-foreground text-xs leading-relaxed">
            <code className="font-mono">gatekeeper endpoint trust add … --from-upstream</code> verifies the endpoint
            itself and prints the <code className="font-mono">evidenceDigest</code> it found before it writes anything.
            It must match this string, character for character, before you answer <code className="font-mono">y</code>.
            They differ when the deployment has changed since this page loaded — reload and look again rather than
            accepting it.
          </p>
        </>
      ) : (
        <p className="mt-3 max-w-prose text-muted-foreground text-xs leading-relaxed">
          {presentation.note} There is nothing to compare a <code className="font-mono">--from-upstream</code> report
          against right now, so pin nothing until a bundle is published again.
        </p>
      )}
    </section>
  );
}
