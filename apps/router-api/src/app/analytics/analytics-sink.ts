import { Logger } from '@nestjs/common';

/** Scalars only — the taxonomy forbids nested objects (`analytics-events.md`, convention 4). */
export type AnalyticsPropertyValue = string | number | boolean;

/** One event, already validated against the taxonomy and ready to leave the process. */
export interface AnalyticsEnvelope {
  event: string;
  /** The account's UUID, or a per-request random one when `anonymous`. */
  distinctId: string;
  /** Stable per-event id; see `eventUuid`. */
  uuid: string;
  timestamp: Date;
  properties: Record<string, AnalyticsPropertyValue>;
  /**
   * Person properties to set on the profile. Allow-listed by
   * {@link PERSON_PROPERTIES}; empty for an anonymous event, which has no profile.
   */
  person: Record<string, string>;
  /**
   * No person profile is created or updated for this event. PostHog bills and
   * stitches on profiles, and an event captured before an account exists has
   * nobody to attach to (ADR-006 §4).
   */
  anonymous: boolean;
}

/**
 * The two person properties a profile may carry. Not a PostHog setting — a
 * setting is a thing someone can change in a UI, and "no email, no name on a
 * profile" is the claim `/privacy` makes.
 */
export const PERSON_PROPERTIES = ['campaign', 'signup_method'] as const;

/**
 * Where a captured event goes.
 *
 * An interface with two implementations rather than the `posthog-node` SDK. The
 * library brings a background flush queue, a retry buffer and a shutdown hook
 * for a payload that is one small JSON POST, and every one of those is something
 * that can hold a request open or lose a batch on a rolling restart. What the
 * router needs is a `fetch` with a timeout — and an interface a test can record
 * against with no network at all.
 */
export interface AnalyticsSink {
  send(envelope: AnalyticsEnvelope): Promise<void>;
}

export const ANALYTICS_SINK = Symbol('ANALYTICS_SINK');

/**
 * The sink a deployment with no `POSTHOG_PROJECT_KEY` gets.
 *
 * Dropping silently is right here: analytics is an operator's instrumentation,
 * not a product feature, and `nx serve`, every unit test and the e2e suite all
 * run without a project. The one warning at boot is what keeps that from being a
 * surprise in production.
 */
export class DisabledAnalyticsSink implements AnalyticsSink {
  async send(): Promise<void> {
    // Nothing, by design.
  }
}

export interface PostHogSinkOptions {
  projectKey: string;
  /** Ingest origin — `https://eu.i.posthog.com` for the EU cloud (ADR-006). */
  host: string;
  requestTimeoutMs: number;
}

/**
 * PostHog's capture endpoint over `fetch`.
 *
 * Three properties are set on every event and are not the caller's to choose:
 *
 *  - `$ip: null`, because with server-side capture the only address PostHog
 *    would otherwise see is the cluster's, which would geolocate every customer
 *    to wherever the router happens to run;
 *  - `$process_person_profile: false` on an anonymous event;
 *  - `$lib`, so an operator reading a raw event can tell what sent it.
 *
 * A failure is logged and swallowed. Every caller is on a request path that has
 * already committed its database work: losing an event is a gap in a chart,
 * while failing the request that produced it would be a bug in the product.
 */
export class PostHogSink implements AnalyticsSink {
  private readonly logger = new Logger(PostHogSink.name);

  constructor(private readonly options: PostHogSinkOptions) {}

  async send(envelope: AnalyticsEnvelope): Promise<void> {
    try {
      const response = await fetch(`${this.options.host.replace(/\/+$/, '')}/capture/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
        body: JSON.stringify({
          api_key: this.options.projectKey,
          event: envelope.event,
          distinct_id: envelope.distinctId,
          uuid: envelope.uuid,
          timestamp: envelope.timestamp.toISOString(),
          properties: {
            ...envelope.properties,
            $ip: null,
            $lib: 'router-api',
            ...(envelope.anonymous ? { $process_person_profile: false } : {}),
            ...(Object.keys(envelope.person).length > 0 ? { $set: envelope.person } : {}),
          },
        }),
      });
      if (!response.ok) {
        this.logger.warn(`PostHog refused ${envelope.event}: ${response.status}.`);
      }
    } catch (error) {
      this.logger.warn(
        `PostHog could not be reached for ${envelope.event}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
