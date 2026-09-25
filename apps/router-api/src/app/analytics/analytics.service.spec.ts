import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from './analytics.service.js';
import type { AnalyticsEnvelope, AnalyticsSink } from './analytics-sink.js';

class RecordingSink implements AnalyticsSink {
  readonly sent: AnalyticsEnvelope[] = [];

  async send(envelope: AnalyticsEnvelope): Promise<void> {
    this.sent.push(envelope);
  }

  get last(): AnalyticsEnvelope {
    const envelope = this.sent.at(-1);
    if (!envelope) {
      throw new Error('Nothing was captured.');
    }
    return envelope;
  }
}

function service(sink: AnalyticsSink = new RecordingSink()): { analytics: AnalyticsService; sink: AnalyticsSink } {
  return { analytics: new AnalyticsService(sink), sink };
}

describe('AnalyticsService', () => {
  it('sends the properties the taxonomy declares for the event', async () => {
    const sink = new RecordingSink();
    const { analytics } = service(sink);

    await analytics.capture({
      event: 'signup_completed',
      distinctId: 'user-1',
      uuid: 'e1',
      properties: { has_invite: true, campaign: 'launch', method: 'password' },
    });

    expect(sink.last).toMatchObject({
      event: 'signup_completed',
      distinctId: 'user-1',
      uuid: 'e1',
      properties: { has_invite: true, campaign: 'launch', method: 'password' },
      anonymous: false,
    });
  });

  it('omits an absent property rather than sending null', async () => {
    const sink = new RecordingSink();
    const { analytics } = service(sink);

    await analytics.capture({
      event: 'signup_completed',
      distinctId: 'user-1',
      uuid: 'e1',
      properties: { has_invite: false, campaign: undefined, method: 'magic_link' },
    });

    // "Absent, never null": `null` and "missing" would be two rows in every
    // breakdown and mean the same thing.
    expect('campaign' in sink.last.properties).toBe(false);
  });

  it('drops a property the taxonomy does not declare for that event', async () => {
    const sink = new RecordingSink();
    const { analytics } = service(sink);

    await analytics.capture({
      event: 'api_key_created',
      distinctId: 'user-1',
      uuid: 'e1',
      // `method` belongs to `signup_completed`, and `email` belongs nowhere.
      properties: { keys_after: 1, has_spend_limit: false, method: 'password', email: 'someone@example.com' },
    });

    expect(sink.last.properties).toEqual({ keys_after: 1, has_spend_limit: false });
  });

  it('gives an anonymous event a distinct id of its own and no person profile', async () => {
    const sink = new RecordingSink();
    const { analytics } = service(sink);

    await analytics.capture({ event: 'signup_started', distinctId: null, uuid: 'e1', properties: { entry: 'direct' } });
    await analytics.capture({ event: 'signup_started', distinctId: null, uuid: 'e2', properties: { entry: 'direct' } });

    // A shared constant would report every sign-up screen in the product as one
    // visitor; a stored identifier is what ADR-006 §4 rules out.
    expect(sink.sent[0].distinctId).not.toBe(sink.sent[1].distinctId);
    expect(sink.sent[0]).toMatchObject({ anonymous: true, person: {} });
  });

  it('sets only the two allowed person properties', async () => {
    const sink = new RecordingSink();
    const { analytics } = service(sink);

    await analytics.capture({
      event: 'signup_completed',
      distinctId: 'user-1',
      uuid: 'e1',
      properties: { has_invite: true, method: 'github' },
      person: { campaign: 'launch', signup_method: 'github', email: 'someone@example.com' } as Record<string, string>,
    });

    expect(sink.last.person).toEqual({ campaign: 'launch', signup_method: 'github' });
  });

  it('never rejects when the sink throws', async () => {
    const failing: AnalyticsSink = {
      send: vi.fn().mockRejectedValue(new Error('PostHog is unreachable')),
    };
    const { analytics } = service(failing);

    // Every caller sits after a committed database write. Losing an event is a
    // gap in a chart; failing the request that produced it would be a bug.
    await expect(
      analytics.capture({ event: 'signup_started', distinctId: null, uuid: 'e1', properties: { entry: 'direct' } }),
    ).resolves.toBeUndefined();
  });
});
