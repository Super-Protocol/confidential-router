import { Injectable } from '@nestjs/common';

/** What `/health` says about product analytics. */
export interface AnalyticsStatus {
  /** `configured` once a sink that can actually deliver has been built. */
  status: 'configured' | 'disabled';
  /** Events lost since this process started, whatever lost them. */
  dropped: number;
}

/**
 * Whether analytics is alive, and how much of it has been lost — the one piece
 * of analytics state that outlives a log line.
 *
 * `POSTHOG_PROJECT_KEY` is a deployment environment value rather than an image
 * build argument (`docs/contracts/analytics-events.md`), which is the right
 * design and also means nothing stops a rebuild from forgetting it. Before this,
 * a deployment that had: the ingest answered 202 either way, both sinks swallow
 * what they lose, and the single boot warning scrolled away. So the state lives
 * here, in a process-lifetime object `/health` can read — the same reasoning as
 * `MailService.status()` (SUP-269), one subsystem over.
 *
 * `status` is set by {@link createAnalyticsSink} when it builds a sink that can
 * deliver, rather than re-read from configuration, so what `/health` reports is
 * what the process is actually using. A default of `disabled` is the honest
 * answer for a process where that never happened.
 *
 * `dropped` is monotonic and never reset: an operator reads it twice and
 * subtracts. A breakdown by reason would be nice; one number is what makes a
 * silent subsystem visible, and that is the whole point.
 */
@Injectable()
export class AnalyticsHealth {
  private deliverable = false;
  private droppedEvents = 0;

  /** The process has a sink that can reach PostHog. */
  sinkConfigured(): void {
    this.deliverable = true;
  }

  /** One event will never reach PostHog. Call it wherever that is decided. */
  eventDropped(): void {
    this.droppedEvents += 1;
  }

  status(): AnalyticsStatus {
    return { status: this.deliverable ? 'configured' : 'disabled', dropped: this.droppedEvents };
  }
}
