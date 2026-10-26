import type { ConfigType } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { routerConfig } from '../config.js';
import { createAnalyticsSink } from './analytics.module.js';
import { AnalyticsHealth } from './analytics-health.js';
import { DisabledAnalyticsSink, PostHogSink } from './analytics-sink.js';

function config(projectKey: string | undefined): ConfigType<typeof routerConfig> {
  return {
    analytics: { posthog: { projectKey, host: 'https://eu.i.posthog.com', requestTimeout: 3000 } },
  } as ConfigType<typeof routerConfig>;
}

describe('createAnalyticsSink', () => {
  it('reports `configured` when a project key is set', () => {
    const health = new AnalyticsHealth();

    const sink = createAnalyticsSink(config('phc_test'), health);

    expect(sink).toBeInstanceOf(PostHogSink);
    expect(health.status()).toEqual({ status: 'configured', dropped: 0 });
  });

  it('reports `disabled` when it is not', () => {
    const health = new AnalyticsHealth();

    const sink = createAnalyticsSink(config(undefined), health);

    expect(sink).toBeInstanceOf(DisabledAnalyticsSink);
    expect(health.status()).toEqual({ status: 'disabled', dropped: 0 });
  });
});
