import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsHealth } from './analytics-health.js';
import {
  type AnalyticsEnvelope,
  type AnalyticsSink,
  DisabledAnalyticsSink,
  PostHogSink,
  type PostHogSinkOptions,
} from './analytics-sink.js';

const ENVELOPE: AnalyticsEnvelope = {
  event: 'signup_completed',
  distinctId: 'user-1',
  uuid: '00000000-0000-4000-8000-000000000000',
  timestamp: new Date('2026-09-25T12:00:00.000Z'),
  properties: { has_invite: true, method: 'password' },
  person: { signup_method: 'password' },
  anonymous: false,
};

function sink(options: Partial<PostHogSinkOptions> = {}, health = new AnalyticsHealth()): PostHogSink {
  return new PostHogSink(
    {
      projectKey: 'phc_test',
      host: 'https://eu.i.posthog.com',
      requestTimeoutMs: 1000,
      ...options,
    },
    health,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(response instanceof Error ? () => Promise.reject(response) : () => Promise.resolve(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('PostHogSink', () => {
  it('posts one capture with the project key and the event id', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 200 }));

    await sink().send(ENVELOPE);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://eu.i.posthog.com/capture/');
    expect(JSON.parse(init.body as string)).toMatchObject({
      api_key: 'phc_test',
      event: 'signup_completed',
      distinct_id: 'user-1',
      uuid: '00000000-0000-4000-8000-000000000000',
      timestamp: '2026-09-25T12:00:00.000Z',
      properties: { has_invite: true, method: 'password', $set: { signup_method: 'password' } },
    });
  });

  it('discards the caller address on every event', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 200 }));

    await sink().send(ENVELOPE);

    // With server-side capture the only address PostHog would see is the
    // cluster's, which would geolocate every customer to wherever we run.
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).properties.$ip).toBeNull();
  });

  it('asks for no person profile on an anonymous event', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 200 }));

    await sink().send({ ...ENVELOPE, anonymous: true, person: {} });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.properties.$process_person_profile).toBe(false);
    expect(body.properties.$set).toBeUndefined();
  });

  it('trims a trailing slash off the configured host', async () => {
    const fetchMock = stubFetch(new Response('{}', { status: 200 }));

    await sink({ host: 'https://eu.i.posthog.com/' }).send(ENVELOPE);

    expect(fetchMock.mock.calls[0][0]).toBe('https://eu.i.posthog.com/capture/');
  });

  it('swallows a refusal and a transport failure alike', async () => {
    stubFetch(new Response('nope', { status: 500 }));
    await expect(sink().send(ENVELOPE)).resolves.toBeUndefined();

    stubFetch(new Error('ECONNREFUSED'));
    await expect(sink().send(ENVELOPE)).resolves.toBeUndefined();
  });

  it('counts a refusal as a dropped event', async () => {
    const health = new AnalyticsHealth();
    stubFetch(new Response('nope', { status: 500 }));

    await sink({}, health).send(ENVELOPE);

    // Swallowed on the request path, visible on `/health` (SUP-464).
    expect(health.status().dropped).toBe(1);
  });

  it('counts a transport failure as a dropped event', async () => {
    const health = new AnalyticsHealth();
    stubFetch(new Error('ECONNREFUSED'));

    await sink({}, health).send(ENVELOPE);

    expect(health.status().dropped).toBe(1);
  });

  it('counts nothing when PostHog accepts the event', async () => {
    const health = new AnalyticsHealth();
    stubFetch(new Response('{}', { status: 200 }));

    await sink({}, health).send(ENVELOPE);

    expect(health.status().dropped).toBe(0);
  });
});

describe('DisabledAnalyticsSink', () => {
  it('counts every event it discards', async () => {
    const health = new AnalyticsHealth();
    const disabled: AnalyticsSink = new DisabledAnalyticsSink(health);

    await disabled.send(ENVELOPE);
    await disabled.send(ENVELOPE);

    // The whole failure mode SUP-464 is about: a deployment that lost its
    // project key drops every event, and before this nothing said so. `status`
    // is `createAnalyticsSink`'s to set, so a sink built here stays `disabled`.
    expect(health.status()).toEqual({ status: 'disabled', dropped: 2 });
  });
});
