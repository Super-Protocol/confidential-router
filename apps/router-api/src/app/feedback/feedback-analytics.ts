import { Logger } from '@nestjs/common';

/** Injection token for whatever forwards `feedback_grant_applied`. */
export const FEEDBACK_ANALYTICS = Symbol('FEEDBACK_ANALYTICS');

/**
 * `feedback_grant_applied`, with the properties the taxonomy declares for it
 * (`schemas/analytics-taxonomy.json`, which lands with SUP-143; this event is
 * SUP-149's).
 *
 * `uuid` is the idempotency key PostHog deduplicates on: the ledger entry id
 * when the grant landed, and the webhook delivery id when it did not — so a
 * provider redelivery can never show up as two grants.
 */
export interface FeedbackGrantAppliedEvent {
  uuid: string;
  distinctId: string;
  outcome: 'granted' | 'refused';
  grantMicros: number;
  reason?: string;
}

/**
 * Where a server-side analytics event goes.
 *
 * A port with a no-op default rather than a PostHog client, because the
 * transport belongs to SUP-145: ADR-006 §3 puts one `posthog-node` capture
 * service and one first-party ingest in that change, and five of its six
 * server-side events there. What belongs here is the *emission* — the moment,
 * the outcome and the idempotency key, which are facts only this feature knows
 * — so binding the real capture service to this token is the whole of the
 * follow-up.
 *
 * Emission never blocks and never fails a request (ADR-006, Consequences): an
 * analytics outage must be invisible to a user who has just earned $100.
 */
export interface FeedbackAnalytics {
  grantApplied(event: FeedbackGrantAppliedEvent): void;
}

/**
 * The default binding: records the event in the service log and nothing else.
 *
 * Not silent, because until the capture service lands this log line is the only
 * place the funnel's last step is visible at all.
 */
export class LoggingFeedbackAnalytics implements FeedbackAnalytics {
  private readonly logger = new Logger('FeedbackAnalytics');

  grantApplied(event: FeedbackGrantAppliedEvent): void {
    this.logger.log(
      `feedback_grant_applied outcome=${event.outcome} grant_micros=${event.grantMicros}` +
        `${event.reason ? ` reason=${event.reason}` : ''} uuid=${event.uuid}`,
    );
  }
}
