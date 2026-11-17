import { describe, expect, it } from 'vitest';
import { CONSOLE_EVENTS_PATH, LEGACY_CONSOLE_EVENTS_PATH } from './analytics-ingest.controller.js';

/**
 * The one test that keeps the fix from rotting.
 *
 * `/v1/analytics/events` was blocked for every visitor running a default
 * blocklist: EasyPrivacy's line 311 is the unanchored pattern
 * `/analytics/event$domain=~app.diagrams.net`, so it matched our path and the
 * only site exempted from it was `app.diagrams.net`. EasyPrivacy ships enabled
 * in uBlock Origin, Brave Shields and AdGuard, which is most blocker users, and
 * a developer audience is heavily blocked — so `signup_started` was never
 * arriving from a large part of it (SUP-463).
 *
 * That makes the route's spelling a behaviour, not a detail. A rename back to
 * anything a list is written with — or a well-meaning `/v1/console-events/track`
 * added next to it — has to fail the build rather than quietly cost the funnel's
 * first step again, because nothing else about the application would look wrong.
 */

/**
 * The words the blocklists' path rules are written with. Not an exhaustive
 * reading of every list — a literal list of the ones that burned us and the
 * near neighbours, which is what a constant can be checked against.
 */
const BLOCKED_WORDS = ['analytics', '/event', 'track', 'collect', 'telemetry', 'pixel', 'beacon', 'stats'];

describe('the console event ingest path', () => {
  it.each(BLOCKED_WORDS)('does not contain "%s"', (word) => {
    expect(CONSOLE_EVENTS_PATH).not.toContain(word);
  });

  it('is the exact path the console posts to', () => {
    // Spelled out rather than derived: `apps/router-ui/src/lib/console-analytics.ts`
    // holds the same literal (it keeps `libs/types` out of the client bundle),
    // and the two agreeing is the whole contract.
    expect(CONSOLE_EVENTS_PATH).toBe('v1/console-events');
  });

  it('keeps the path SUP-145 shipped unchanged, so a split deploy drops nothing', () => {
    // The alias exists precisely because it matches a blocklist rule: a console
    // still serving the old bundle sends there, and whatever reaches us is
    // better than nothing until that bundle is gone. Removing it is a follow-up.
    expect(LEGACY_CONSOLE_EVENTS_PATH).toBe('v1/analytics/events');
    expect(LEGACY_CONSOLE_EVENTS_PATH).not.toBe(CONSOLE_EVENTS_PATH);
  });
});
