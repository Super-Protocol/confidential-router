/**
 * The analytics event names both surfaces emit (ADR-006).
 *
 * The contract itself is `schemas/analytics-taxonomy.json` — the landing page lives in a second
 * repository and cannot import TypeScript from this one, so the taxonomy has to be a data file rather
 * than a module. What follows is this repository's typed view of it: names as a union, the property
 * spellings each event carries, and where it is emitted from.
 *
 * It is hand-written rather than generated, for the same reason the JSON Schemas are: a generated
 * artefact is not reviewable, and the interesting change is never the shape but the name. Drift is not
 * a risk taken on trust — `analytics.spec.ts` compares every name, property and surface in both
 * directions against the JSON and fails on the first disagreement.
 */

/**
 * Where an event is emitted from. `api` is router-api's own server-side capture; `console` is the
 * browser, which reaches PostHog only through router-api (ADR-006 §3), never directly.
 */
export type AnalyticsSurface = 'landing' | 'console' | 'api';

/** Every event in the taxonomy, in the order the funnel visits them. */
export const ANALYTICS_EVENTS = [
  'landing_view',
  'cta_click',
  'diagram_variant_shown',
  'code_copied',
  'faq_opened',
  'docs_link_click',
  'signup_started',
  'signup_completed',
  'invite_redeemed',
  'api_key_created',
  'first_request_sent',
  'model_requested',
  'feedback_form_opened',
  'feedback_grant_applied',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

/**
 * Which surface owns each event. The console and the API are both PostHog; the landing is Plausible,
 * in another repository, and appears here only so the funnel can be described in one place.
 */
export const ANALYTICS_EVENT_SURFACE = {
  landing_view: 'landing',
  cta_click: 'landing',
  diagram_variant_shown: 'landing',
  code_copied: 'landing',
  faq_opened: 'landing',
  docs_link_click: 'landing',
  signup_started: 'console',
  signup_completed: 'api',
  invite_redeemed: 'api',
  api_key_created: 'api',
  first_request_sent: 'api',
  model_requested: 'api',
  feedback_form_opened: 'console',
  feedback_grant_applied: 'api',
} as const satisfies Record<AnalyticsEventName, AnalyticsSurface>;

/**
 * Every property name each event may carry, shared ones included, sorted.
 *
 * router-api validates an incoming console event against this before forwarding it: the first-party
 * ingest is a public endpoint, and an allow-list is what stops it becoming a way to write arbitrary
 * rows into our analytics.
 */
export const ANALYTICS_EVENT_PROPERTIES = {
  landing_view: ['campaign', 'has_invite', 'utm_campaign', 'utm_content', 'utm_medium', 'utm_source'],
  cta_click: ['campaign', 'has_invite', 'position', 'target', 'utm_campaign'],
  diagram_variant_shown: ['variant', 'viewport_bucket'],
  code_copied: ['has_invite', 'snippet'],
  faq_opened: ['question_id'],
  docs_link_click: ['destination', 'position'],
  signup_started: ['campaign', 'entry', 'has_invite', 'utm_campaign'],
  signup_completed: ['campaign', 'has_invite', 'method'],
  invite_redeemed: ['campaign', 'grant_micros', 'outcome', 'reason'],
  api_key_created: ['campaign', 'has_spend_limit', 'keys_after'],
  first_request_sent: ['campaign', 'had_invite_grant', 'hours_since_signup', 'model_slug'],
  model_requested: ['has_details', 'source'],
  feedback_form_opened: ['grant_eligible', 'source'],
  feedback_grant_applied: ['grant_micros', 'outcome', 'reason'],
} as const satisfies Record<AnalyticsEventName, readonly string[]>;

/**
 * The events the browser may post to router-api's ingest. Everything else about an account is
 * something the server already knows, and an event the server can derive is an event a client cannot
 * be allowed to assert.
 */
export const CONSOLE_INGEST_EVENTS = ['signup_started', 'feedback_form_opened'] as const;

export type ConsoleIngestEventName = (typeof CONSOLE_INGEST_EVENTS)[number];

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && (ANALYTICS_EVENTS as readonly string[]).includes(value);
}

export function isConsoleIngestEventName(value: unknown): value is ConsoleIngestEventName {
  return typeof value === 'string' && (CONSOLE_INGEST_EVENTS as readonly string[]).includes(value);
}

/** Whether `property` is one the taxonomy declares for `event`. */
export function isAnalyticsProperty(event: AnalyticsEventName, property: string): boolean {
  return (ANALYTICS_EVENT_PROPERTIES[event] as readonly string[]).includes(property);
}
