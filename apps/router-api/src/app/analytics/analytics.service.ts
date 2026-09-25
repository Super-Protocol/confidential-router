import { randomUUID } from 'node:crypto';
import { type AnalyticsEventName, isAnalyticsProperty } from '@confidential-router/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ANALYTICS_SINK,
  type AnalyticsPropertyValue,
  type AnalyticsSink,
  PERSON_PROPERTIES,
} from './analytics-sink.js';

/**
 * One event as a caller describes it. Optional properties are written as
 * `undefined` and dropped, never sent as `null` — "absent, never null"
 * (`docs/contracts/analytics-events.md`, convention 3).
 */
export interface CaptureInput {
  event: AnalyticsEventName;
  /**
   * The account's UUID, or `null` for an event that has no account yet. An
   * anonymous event gets a throwaway `distinct_id` and no person profile: the
   * alternative is an identifier stored in the visitor's browser, which is what
   * ADR-006 §4 rules out and what would put a consent banner in front of the
   * campaign we are measuring.
   */
  distinctId: string | null;
  /** Stable per-event id. Use {@link eventUuid} over the row being reported. */
  uuid: string;
  properties?: Record<string, AnalyticsPropertyValue | undefined>;
  /** Person properties; silently restricted to {@link PERSON_PROPERTIES}. */
  person?: Record<string, string | undefined>;
  /** Defaults to now. Pass the row's own timestamp where there is one. */
  timestamp?: Date;
}

/**
 * Product analytics, the one place the router talks to PostHog.
 *
 * Two things it is not. It is not a queue: `capture` resolves once the attempt
 * has been made, so a test asserts on a recorded event rather than on a timer,
 * and a caller that wants to get on with its request simply does not await.
 * And it is not a pass-through: every event and every property is checked
 * against the taxonomy in `libs/types` before it leaves, because the console's
 * ingest is a public endpoint and an allow-list is what stops it becoming a way
 * to write arbitrary rows into our analytics (ADR-006 §3).
 *
 * `capture` never throws and never rejects. Every caller sits after a committed
 * database write, where the only correct answer to "the analytics host is down"
 * is to carry on.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(@Inject(ANALYTICS_SINK) private readonly sink: AnalyticsSink) {}

  async capture(input: CaptureInput): Promise<void> {
    try {
      await this.sink.send({
        event: input.event,
        // A random id rather than a constant such as `anonymous`: PostHog
        // counts unique users by `distinct_id`, and one shared value would
        // report every sign-up screen in the product as a single visitor.
        distinctId: input.distinctId ?? randomUUID(),
        uuid: input.uuid,
        timestamp: input.timestamp ?? new Date(),
        properties: this.declaredProperties(input.event, input.properties),
        person: input.distinctId === null ? {} : personProperties(input.person),
        anonymous: input.distinctId === null,
      });
    } catch (error) {
      // The sinks swallow their own transport failures; this covers a
      // programming error in the envelope, which must still not fail a request.
      this.logger.error(
        `Analytics capture of ${input.event} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The properties the taxonomy declares for this event, with the absent ones
   * omitted.
   *
   * An undeclared property is dropped and logged rather than rejected: the
   * caller has already committed the thing it is reporting, so the choice is
   * between an event with one property missing and no event at all.
   */
  private declaredProperties(
    event: AnalyticsEventName,
    properties: Record<string, AnalyticsPropertyValue | undefined> = {},
  ): Record<string, AnalyticsPropertyValue> {
    const declared: Record<string, AnalyticsPropertyValue> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (value === undefined) {
        continue;
      }
      if (!isAnalyticsProperty(event, key)) {
        this.logger.warn(`Dropped undeclared analytics property "${key}" on ${event}.`);
        continue;
      }
      declared[key] = value;
    }
    return declared;
  }
}

function personProperties(person: Record<string, string | undefined> = {}): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const name of PERSON_PROPERTIES) {
    const value = person[name];
    if (value !== undefined) {
      allowed[name] = value;
    }
  }
  return allowed;
}
