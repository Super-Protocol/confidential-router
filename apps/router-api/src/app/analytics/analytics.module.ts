import { Logger, Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { routerConfig } from '../config.js';
import { AnalyticsService } from './analytics.service.js';
import { ANALYTICS_SINK, type AnalyticsSink, DisabledAnalyticsSink, PostHogSink } from './analytics-sink.js';

/**
 * Picks the sink from configuration: PostHog when a project key is set, nothing
 * otherwise (ADR-006).
 *
 * `analytics.posthog.projectKey` is a write-only ingest key rather than a secret,
 * and it is absent on every developer machine and in every test — so an
 * unconfigured deployment gets a sink that drops, and says so once at boot. That
 * is the opposite of the `billing` choice, where the fallback provider can mint
 * money and is therefore fatal in production: a missing chart is not a
 * correctness problem, and failing the boot over one would make the campaign's
 * instrumentation a deployment prerequisite for serving traffic.
 */
export function createAnalyticsSink(config: ConfigType<typeof routerConfig>): AnalyticsSink {
  const { posthog } = config.analytics;
  if (!posthog.projectKey) {
    new Logger('AnalyticsModule').warn(
      'analytics.posthog.projectKey is not configured; product events are discarded. ' +
        'Set POSTHOG_PROJECT_KEY to capture them.',
    );
    return new DisabledAnalyticsSink();
  }
  return new PostHogSink({
    projectKey: posthog.projectKey,
    host: posthog.host,
    requestTimeoutMs: posthog.requestTimeout,
  });
}

/**
 * Product analytics. Transport only — it knows the taxonomy and nothing about
 * invitations, keys or generations.
 *
 * That is what lets every emitter import it without a cycle: the events are
 * captured where the fact they report is committed, so `AuthModule`,
 * `MeteringModule` and the console resolvers all depend on this module and it
 * depends on none of them. The console's ingest endpoint lives in
 * `api/analytics` for the same reason — see `AnalyticsIngestModule`.
 */
@Module({
  providers: [
    {
      provide: ANALYTICS_SINK,
      inject: [routerConfig.KEY],
      useFactory: createAnalyticsSink,
    },
    AnalyticsService,
  ],
  exports: [AnalyticsService, ANALYTICS_SINK],
})
export class AnalyticsModule {}
