import { publicConfig } from './public-config';

/**
 * The two events the browser is allowed to assert, and the only analytics code in
 * the console bundle.
 *
 * There is no `posthog-js` here and there will not be. The console reaches PostHog
 * through router-api and nothing else (ADR-006 §3): a browser SDK would have
 * bought these two events and written a persistent identifier to the visitor's
 * device, which is what ePrivacy Art. 5(3) attaches consent to — and a consent
 * banner in front of the campaign we are measuring costs more than the events are
 * worth. Everything else the console could report is a fact router-api commits to
 * the database anyway, so it captures those server-side.
 *
 * The names are the taxonomy's (`docs/contracts/analytics-events.md`) and are
 * spelled out rather than imported: router-api validates every name and property
 * against the taxonomy before forwarding, so the allow-list with teeth is there,
 * and a literal here keeps `libs/types` out of the client bundle.
 */
export type ConsoleEvent = 'signup_started' | 'feedback_form_opened';

export type EventProperties = Record<string, string | number | boolean | undefined>;

/**
 * Records one event. Resolves whatever happened, and never throws.
 *
 * Analytics must not be able to break a screen: a blocked request, an offline
 * browser or an extension that refuses the call all have to cost the event and
 * nothing else. `keepalive` so an event sent as the visitor navigates away — which
 * `signup_started` is not, but a future `cta_click` would be — still leaves.
 */
export async function captureConsoleEvent(event: ConsoleEvent, properties: EventProperties = {}): Promise<void> {
  try {
    await fetch(`${publicConfig().apiOrigin}/v1/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The session cookie lives on the API origin. `feedback_form_opened` is
      // recorded against the account, so it has to be sent; `signup_started` is
      // captured anonymously whether one arrives or not.
      credentials: 'include',
      keepalive: true,
      body: JSON.stringify({ event, properties: defined(properties) }),
    });
  } catch {
    // Deliberately silent. A console that logged a failed analytics call would be
    // telling the viewer about our instrumentation, which is not their problem.
  }
}

/** "Absent, never null": an optional property is omitted, not sent as undefined. */
function defined(properties: EventProperties): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined)) as Record<
    string,
    string | number | boolean
  >;
}
