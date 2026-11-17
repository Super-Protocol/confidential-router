import { beforeEach, describe, expect, it } from 'vitest';
import { RecordingAnalyticsSink } from '../../../test/analytics-recorder.js';
import { AnalyticsHealth } from '../analytics/analytics-health.js';
import { AnalyticsService, type AnalyticsSink, eventUuid } from '../analytics/index.js';
import { CapturingFeedbackAnalytics, type FeedbackGrantAppliedEvent } from './feedback-analytics.js';

/**
 * The binding the funnel's last step goes out through.
 *
 * Two properties carry the weight. The idempotency key has to be a *function* of
 * the id the recorder hands over, because that is the whole reason the port
 * carries one — PostHog deduplicates on it, and a provider that redelivers a
 * submission must not produce a second grant in the chart. And the event must
 * carry the outcome and nothing the respondent wrote: the answers, the email and
 * the signed link never leave the database (ADR-006 §5).
 */

const LEDGER_ENTRY_ID = '7b4a1d3e-8c2f-4a51-9d6b-0f5e2c7a1b94';
const USER_ID = '2f1c0b9a-5d4e-4f3a-8b7c-6a5d4e3f2b1c';

const granted: FeedbackGrantAppliedEvent = {
  uuid: LEDGER_ENTRY_ID,
  distinctId: USER_ID,
  outcome: 'granted',
  grantMicros: 100_000_000,
};

const refused: FeedbackGrantAppliedEvent = {
  uuid: 'submission-1',
  distinctId: USER_ID,
  outcome: 'refused',
  reason: 'already_granted',
};

let sink: RecordingAnalyticsSink;
let analytics: CapturingFeedbackAnalytics;

beforeEach(() => {
  sink = new RecordingAnalyticsSink();
  analytics = new CapturingFeedbackAnalytics(new AnalyticsService(sink, new AnalyticsHealth()));
});

describe('a grant that landed', () => {
  it('captures feedback_grant_applied against the account, with the amount credited', () => {
    analytics.grantApplied(granted);

    const envelope = sink.one('feedback_grant_applied');
    expect(envelope.distinctId).toBe(USER_ID);
    expect(envelope.anonymous).toBe(false);
    expect(envelope.properties).toEqual({ outcome: 'granted', grant_micros: 100_000_000 });
  });

  it('keys the event on the ledger entry, so the same entry is always the same event', () => {
    analytics.grantApplied(granted);
    analytics.grantApplied(granted);

    const [first, second] = sink.all('feedback_grant_applied');
    // The deduplication key, which is what makes a redelivery that slipped past
    // every other guard cost one row in PostHog rather than two grants.
    expect(first.uuid).toBe(second.uuid);
    expect(first.uuid).toBe(eventUuid('feedback_grant_applied', LEDGER_ENTRY_ID));
    expect(first.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('gives two different grants two different keys', () => {
    analytics.grantApplied(granted);
    analytics.grantApplied({ ...granted, uuid: 'a7c3e5f1-2b4d-4e6a-8c9f-1d3b5a7c9e1f' });

    const [first, second] = sink.all('feedback_grant_applied');
    expect(first.uuid).not.toBe(second.uuid);
  });
});

describe('a grant that was refused', () => {
  it('reports the outcome and the reason, and no amount at all', () => {
    analytics.grantApplied(refused);

    // `grant_micros` is "present only when `outcome` is `granted`": a zero would
    // be counted as an amount by anything that averages the property.
    expect(sink.one('feedback_grant_applied').properties).toEqual({
      outcome: 'refused',
      reason: 'already_granted',
    });
  });

  it('keys it on the provider delivery, which is not a UUID, without dropping it', () => {
    analytics.grantApplied(refused);

    // PostHog's ingest drops an event whose `uuid` is not UUID-shaped, and a
    // form provider's submission id is whatever string it likes.
    expect(sink.one('feedback_grant_applied').uuid).toBe(eventUuid('feedback_grant_applied', 'submission-1'));
  });
});

describe('whatever analytics does', () => {
  it('never throws and never waits, so a dead PostHog cannot fail the webhook', async () => {
    const dead: AnalyticsSink = {
      send: () => Promise.reject(new Error('posthog is down')),
    };
    const offline = new CapturingFeedbackAnalytics(new AnalyticsService(dead, new AnalyticsHealth()));

    expect(() => offline.grantApplied(granted)).not.toThrow();
    // Flushes the microtask the fire-and-forget capture left behind: an
    // unhandled rejection here would fail the process, not just this test.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('sends nothing the respondent wrote, and nothing that identifies them by email', () => {
    analytics.grantApplied(granted);

    const envelope = sink.one('feedback_grant_applied');
    expect(Object.keys(envelope.properties).sort()).toEqual(['grant_micros', 'outcome']);
    // No profile write either: the funnel's last step is an event about a grant,
    // not a fact about the person.
    expect(envelope.person).toEqual({});
  });
});
