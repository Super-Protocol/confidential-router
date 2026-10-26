import { expect } from 'vitest';
import type { AlertChannelStatus, OperatorAlertsService } from '../src/app/alerts/index.js';
import type { OperatorAlert, OperatorAlertDelivery } from '../src/app/mail/mail.service.js';

/**
 * The alert channel a unit test runs with, in place of mail.
 *
 * Records rather than sends, and answers `status()` the way a configured channel
 * would, so a spec about the pass that *raises* an alert asserts on the raise and
 * leaves delivery to `operator-alerts.service.spec.ts`. The e2e harness needs
 * none of this: it installs `CapturingMailer`, so there the real service runs and
 * the assertion is on the message.
 */
export class RecordingOperatorAlerts {
  readonly raised: Array<{ alert: OperatorAlert; urgent: boolean }> = [];
  readonly tested: string[] = [];

  async raise(
    alert: OperatorAlert,
    _now?: Date,
    options: { urgent?: boolean } = {},
  ): Promise<OperatorAlertDelivery | null> {
    this.raised.push({ alert, urgent: options.urgent === true });
    return { attempted: 1, delivered: ['operator@example.test'], failed: [], skipped: null };
  }

  async sendTest(raisedBy: string): Promise<OperatorAlertDelivery> {
    this.tested.push(raisedBy);
    return { attempted: 1, delivered: ['operator@example.test'], failed: [], skipped: null };
  }

  status(): AlertChannelStatus {
    return { state: 'ready', recipients: 1 };
  }

  get recipients(): string[] {
    return ['operator@example.test'];
  }

  get enabled(): boolean {
    return true;
  }

  /** The one alert whose title contains `fragment`, failing when there is not exactly one. */
  one(fragment: string): OperatorAlert {
    const matches = this.raised.filter((entry) => entry.alert.title.includes(fragment)).map((entry) => entry.alert);
    expect(matches, `expected exactly one alert mentioning "${fragment}", got ${matches.length}`).toHaveLength(1);
    return matches[0];
  }

  /** Every fact on an alert, as a lookup — the shape an assertion actually wants. */
  static factsOf(alert: OperatorAlert): Record<string, string> {
    return Object.fromEntries(alert.facts);
  }

  asService(): OperatorAlertsService {
    return this as unknown as OperatorAlertsService;
  }
}
