import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AnalyticsEnvelope, PostHogSink, type PostHogSinkOptions } from './analytics-sink.js';

const ENVELOPE: AnalyticsEnvelope = {
  event: 'signup_completed',
  distinctId: 'user-1',
  uuid: '00000000-0000-4000-8000-000000000000',
  timestamp: new Date('2026-09-25T12:00:00.000Z'),
  properties: { has_invite: true, method: 'password' },
  person: { signup_method: 'password' },
  anonymous: false,
};

function sink(options: Partial<PostHogSinkOptions> = {}): PostHogSink {
  return new PostHogSink({
    projectKey: 'phc_test',
    host: 'https://eu.i.posthog.com',
    requestTimeoutMs: 1000,
    ...options,
  });
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
});
