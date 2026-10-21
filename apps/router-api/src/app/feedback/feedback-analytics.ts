import { Injectable } from '@nestjs/common';
import { AnalyticsService, eventUuid } from '../analytics/index.js';

/** Injection token for whatever forwards `feedback_grant_applied`. */
export const FEEDBACK_ANALYTICS = Symbol('FEEDBACK_ANALYTICS');

/**
 * `feedback_grant_applied`, with the properties the taxonomy declares for it
 * (`schemas/analytics-taxonomy.json`).
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
 * A port rather than `AnalyticsService` injected directly, because the two
 * halves belong to different places: the *emission* — the moment, the outcome
 * and the idempotency key — are facts only this feature knows, while the
 * transport is ADR-006 §3's one `posthog` capture service. `FeedbackGrantRecorder`
 * holds this interface and never learns which of the two is behind it.
 *
 * Emission never blocks and never fails a request (ADR-006, Consequences): an
 * analytics outage must be invisible to a user who has just earned $100. Which
 * is why `grantApplied` returns `void` — there is nothing a caller could
 * usefully do with a result, and a caller that awaited one would be making the
 * webhook's answer wait on PostHog.
 */
export interface FeedbackAnalytics {
  grantApplied(event: FeedbackGrantAppliedEvent): void;
}

/**
 * The binding `FeedbackModule` uses: the event goes to PostHog through
 * `AnalyticsService`, like every other server-side event in the taxonomy.
 *
 * Fire-and-forget on purpose. `AnalyticsService.capture` neither throws nor
 * rejects — it resolves once the attempt has been made and swallows a transport
 * failure itself — so there is nothing here to handle and nothing to wait for.
 * The webhook has already committed its ledger entry by the time this runs.
 */
@Injectable()
export class CapturingFeedbackAnalytics implements FeedbackAnalytics {
  constructor(private readonly analytics: AnalyticsService) {}

  grantApplied(event: FeedbackGrantAppliedEvent): void {
    void this.analytics.capture({
      event: 'feedback_grant_applied',
      distinctId: event.distinctId,
      // Hashed rather than passed through, because the two ids the port carries
      // have different shapes: the ledger entry id is a UUID, and the provider's
      // delivery id is whatever string the provider mints — which PostHog's
      // ingest drops. The digest is a pure function of the id either way, so the
      // deduplication the key exists for survives the normalisation.
      uuid: eventUuid('feedback_grant_applied', event.uuid),
      properties: {
        outcome: event.outcome,
        // "Present only when `outcome` is `granted`" — a refusal credited
        // nothing, and a zero here would be counted as an amount.
        grant_micros: event.outcome === 'granted' ? event.grantMicros : undefined,
        reason: event.reason,
      },
    });
  }
}
