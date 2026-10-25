'use client';

import { useQuery } from '@apollo/client/react';
import { Badge } from '@confidential-router/ui/components/badge';
import { CopyButton } from '@confidential-router/ui/components/copy-button';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import * as React from 'react';
import { graphql } from '../../generated';
import { formatDigest, formatTimestamp } from '../../lib/format';
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
  /**
   * Where the heading sits in the host page's outline.
   *
   * Not cosmetic: on Overview the block is a section of the page beside "This
   * week's usage" (`h2`), and inside "How to connect" it is part of step 2,
   * under that step's own `h3`. A fixed level made the block read as a fourth
   * numbered step on the API Keys page — which is what `api-keys-screen.spec`
   * caught.
   */
  headingLevel?: 'h2' | 'h3' | 'h4';
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
 * Three outcomes are *said*, never left blank: a deployment that publishes no
 * current bundle, and a query that failed, both render a reason. Nothing at all
 * is reserved for the one case where there is genuinely no question to answer —
 * the router cannot name its own endpoint, so no digest on this page would be
 * the one a `--from-upstream` report is about. A reader standing at that y/n
 * must never meet an empty space: "no digest here" and "a digest you did not
 * find" are what SUP-541 is about.
 */
export function DeploymentDigest({
  title = 'This deployment’s evidence digest',
  headingLevel: Heading = 'h3',
}: DeploymentDigestProps) {
  // The block is mounted on two screens, so the heading's id cannot be a
  // literal — `aria-labelledby` would point at whichever copy rendered first.
  const headingId = React.useId();
  const { data, loading, error, refetch } = useQuery(DEPLOYMENT_DIGEST_QUERY, { fetchPolicy: 'cache-and-network' });

  if (error && !data) {
    return (
      <ErrorState
        title="The deployment’s evidence digest could not be loaded"
        description="Nothing here says what this deployment publishes, so there is nothing to compare a gatekeeper’s report against. Retry before you answer its prompt."
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (!data) {
    return loading ? <Skeleton className="h-28 rounded-xl" aria-hidden="true" /> : null;
  }

  const endpoint = data.routerEndpoint;
  if (!endpoint) {
    return null;
  }

  const snapshot = endpoint.latestEvidence;
  const presentation = evidencePresentation(endpoint.evidenceState);
  const digest = snapshot ? formatDigest(snapshot.evidenceDigestHex, snapshot.evidenceDigest) : null;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="deployment-digest"
      className="rounded-xl border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading id={headingId} className="font-semibold text-sm">
          {title}
        </Heading>
        <Badge variant={presentation.variant}>{presentation.label}</Badge>
      </div>

      {/*
        `issuedAt`, not the quote age: this is the line that tells a reader
        whose gatekeeper printed a different digest which of the two is stale —
        a tab left open since the last deployment, or a deployment that has
        just changed under them.
      */}
      <p className="mt-1 font-mono text-muted-foreground text-xs">
        {endpoint.hostname}
        {snapshot?.tee ? ` · ${snapshot.tee}` : ''}
        {snapshot ? ` · issued ${formatTimestamp(snapshot.issuedAt)}` : ''}
      </p>

      {digest ? (
        <>
          <div className="mt-3 flex items-start gap-2 rounded-lg border bg-muted/40 p-3">
            {/*
              `break-all`, not truncation: the point of this block is that the
              whole value is on the page. `select-all` so one click takes it for
              a reader who would rather diff it than read it.
            */}
            <code data-testid="deployment-digest-value" className="min-w-0 select-all break-all font-mono text-xs">
              {digest}
            </code>
            <CopyButton
              value={digest}
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
