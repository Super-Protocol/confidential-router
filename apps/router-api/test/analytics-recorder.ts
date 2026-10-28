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

  /**
   * Waits for `count` captures of `event`.
   *
   * For the events the request does not await — `model_requested` is reported
   * with `void` precisely so that a refusal is not answered more slowly because
   * of a chart (SUP-542) — so a spec has to wait for the capture rather than
   * assume the response implied it. A poll rather than a fake timer: the capture
   * resolves a real database read on the way.
   */
  async waitFor(event: string, count = 1, timeoutMs = 5_000): Promise<AnalyticsEnvelope[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.all(event).length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const matches = this.all(event);
    expect(
      matches.length,
      `expected ${count} ${event} within ${timeoutMs}ms, got ${matches.length}`,
    ).toBeGreaterThanOrEqual(count);
    return matches;
  }

  reset(): void {
    this.sent.length = 0;
  }
}
