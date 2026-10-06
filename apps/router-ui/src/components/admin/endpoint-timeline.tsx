import { Badge } from '@confidential-router/ui/components/badge';
import type { ExternalEndpointFieldsFragment } from '../../generated/graphql';
import { formatTimestamp, shortenDigest } from '../../lib/format';
import { eventPresentation, showsEvidenceSummary } from './endpoint-status';
import { EvidenceSummary } from './evidence-summary';

type EndpointEvent = ExternalEndpointFieldsFragment['events'][number];

export interface EndpointTimelineProps {
  events: readonly EndpointEvent[];
}

/**
 * The verdict history of one endpoint: what happened, which pipeline stage said
 * so, and what the upstream was running when it did.
 *
 * History, never input — a past "Verified by this router" row is not current
 * trust (ADR-008 §8), which is why the chip at the top of the drawer comes from
 * `status` and never from the newest event here.
 */
export function EndpointTimeline({ events }: EndpointTimelineProps) {
  if (events.length === 0) {
    return <p className="text-muted-foreground text-sm">Nothing has happened to this endpoint yet.</p>;
  }

  return (
    <ol className="space-y-4" data-testid="endpoint-timeline">
      {events.map((event) => {
        const presentation = eventPresentation(event.kind);
        return (
          <li key={event.id} className="border-border border-l-2 pl-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={presentation.variant}>{presentation.label}</Badge>
              <time dateTime={event.at} className="text-muted-foreground text-xs">
                {formatTimestamp(event.at)}
              </time>
              {event.stage ? (
                <span className="text-muted-foreground text-xs">
                  stage <span className="font-mono">{event.stage}</span>
                </span>
              ) : null}
            </div>

            {event.reason ? <p className="mt-1 text-sm">{event.reason}</p> : null}

            <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
              {event.measurement ? (
                <div className="contents">
                  <dt className="text-muted-foreground">Measurement seen</dt>
                  <dd className="font-mono" title={event.measurement}>
                    {shortenDigest(event.measurement, 8)}
                  </dd>
                </div>
              ) : null}
              {event.evidenceDigest ? (
                <div className="contents">
                  <dt className="text-muted-foreground">Digest seen</dt>
                  <dd className="font-mono" title={event.evidenceDigest}>
                    {shortenDigest(event.evidenceDigest, 8)}
                  </dd>
                </div>
              ) : null}
            </dl>

            {/*
              Ruling 1, literally: registration and every change carry the full
              evidence summary, so the operator sees what each admission let in
              without having to reconstruct it from digests.
            */}
            {showsEvidenceSummary(event.kind) && event.evidence ? (
              <div className="mt-3 rounded-lg border bg-muted/30 p-3">
                <EvidenceSummary evidence={event.evidence} heading="What this let in" bare />
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
