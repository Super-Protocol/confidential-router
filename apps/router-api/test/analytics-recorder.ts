import { expect } from 'vitest';
import type { AnalyticsEnvelope, AnalyticsSink } from '../src/app/analytics/index.js';

/**
 * The analytics sink every harness runs with, in place of PostHog.
 *
 * Deliberately always installed, exactly like `CapturingMailer`: the events are
 * emitted from the sign-up hook, the key mutation and the meter, so a suite about
 * any of those can assert what was captured, and no suite can accidentally post
 * to a real project.
 */
export class RecordingAnalyticsSink implements AnalyticsSink {
  readonly sent: AnalyticsEnvelope[] = [];

  async send(envelope: AnalyticsEnvelope): Promise<void> {
    this.sent.push(envelope);
  }

  /** Every capture of one event, oldest first. */
  all(event: string): AnalyticsEnvelope[] {
    return this.sent.filter((envelope) => envelope.event === event);
  }

  /** The one capture of `event`, failing when there is none or more than one. */
  one(event: string): AnalyticsEnvelope {
    const matches = this.all(event);
    expect(matches, `expected exactly one ${event}, got ${matches.length}`).toHaveLength(1);
    return matches[0];
  }

  reset(): void {
    this.sent.length = 0;
  }
}
