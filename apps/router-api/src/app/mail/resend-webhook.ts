import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Everything specific to Resend's webhooks: the delivery signature and the
 * shape of an event payload.
 *
 * Pure functions over bytes, deliberately — the same split `typeform.ts` makes,
 * and for the same reason. What the rest of the feature works in is
 * {@link MailProviderEvent}: a recipient, a verdict and a time. A second
 * provider signing its deliveries some other way is a second file beside this
 * one, and `MailDeliveryService` does not change.
 *
 * **Why this exists at all.** Suppression is applied *after* the relay accepts
 * the message: the SMTP transaction succeeds, `MailService.record()` books a
 * healthy send, and the message is discarded. There is no failure to report, no
 * retry to schedule and no counter that moves — the outcome exists only in the
 * provider's event stream, and these are the bytes that bring it here (SUP-551).
 */

/** The three headers Svix — which Resend delivers through — signs each POST with. */
export const SVIX_ID_HEADER = 'svix-id';
export const SVIX_TIMESTAMP_HEADER = 'svix-timestamp';
export const SVIX_SIGNATURE_HEADER = 'svix-signature';

/** The headers as a controller hands them over, each possibly absent. */
export interface SvixHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

/**
 * How far a delivery's timestamp may be from this clock, either way.
 *
 * Svix's own tolerance, and the point of signing the timestamp at all: without
 * it a signature stays valid forever and a captured delivery can be replayed
 * back at us for as long as the secret lives.
 */
const TIMESTAMP_TOLERANCE_MS = 5 * 60_000;

const SECRET_PREFIX = 'whsec_';

/**
 * Whether the provider signed these exact bytes, recently.
 *
 * Over the raw body, which is why `bootstrap.ts` mounts `express.raw` on this
 * path: a body that has been parsed and reserialised is a different byte string
 * and would fail a signature that was never wrong.
 *
 * The signed content is `<id>.<timestamp>.<body>`, HMAC-SHA256 under the
 * base64-decoded secret, compared in constant time against each versioned
 * entry of the header — the header carries one per signing key, so a secret
 * rotation overlaps rather than drops deliveries.
 */
export function verifyResendSignature(delivery: {
  secret: string;
  rawBody: Buffer;
  headers: SvixHeaders;
  /** Overridden only by a test; the tolerance above is measured from it. */
  now?: Date;
}): boolean {
  const { secret, rawBody, headers, now = new Date() } = delivery;
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    return false;
  }
  const sentAtSeconds = Number(timestamp);
  if (!Number.isFinite(sentAtSeconds)) {
    return false;
  }
  if (Math.abs(now.getTime() - sentAtSeconds * 1000) > TIMESTAMP_TOLERANCE_MS) {
    return false;
  }

  const key = Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest();

  // `v1,<base64> v1,<base64> …` — one entry per signing key the endpoint has.
  return signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) {
      return false;
    }
    const provided = Buffer.from(value, 'base64');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}

/**
 * What one event says about one address, in vocabulary no provider owns.
 *
 * - `bounced` — the receiving server refused the message. Permanent or not, per
 *   {@link MailProviderEvent.permanent}.
 * - `complained` — it was delivered and the recipient marked it as spam. The
 *   provider suppresses the address next, so this is permanent here.
 * - `suppressed` — the provider accepted the message and then discarded it
 *   because the address is on its suppression list. **This is the event the
 *   deployment could not see**, and the one the three dead sign-in codes in
 *   SUP-551 produced.
 * - `failed` — the send itself failed at the provider, before any delivery
 *   attempt: a bad key, a quota, an unverified domain. Not a verdict on the
 *   address.
 * - `delayed` — a transient problem; the provider will retry.
 * - `delivered` / `unsuppressed` — the address is reachable again, and the
 *   recorded rejection is stale.
 */
export type MailEventKind =
  | 'bounced'
  | 'complained'
  | 'suppressed'
  | 'failed'
  | 'delayed'
  | 'delivered'
  | 'unsuppressed';

/** One event, about one address. A delivery naming several recipients yields several. */
export interface MailProviderEvent {
  kind: MailEventKind;
  /** Lower-cased and trimmed, which is the form the state table is keyed by. */
  email: string;
  /** Whether mail to this address is being dropped from here on, rather than retried. */
  permanent: boolean;
  occurredAt: Date;
  /** The provider's own words about it, clipped. Null when it said nothing. */
  detail: string | null;
  /** The provider's message id, so a log line can be matched to its dashboard row. */
  messageId: string | null;
}

/** How long a provider message may be before it is clipped into `detail`. */
export const MAX_DETAIL_LENGTH = 512;

/**
 * Reads a delivery into the events it carries, or `[]` when it carries none we act on.
 *
 * An empty array rather than a throw for an unrecognised `type`: Resend sends
 * `email.sent`, `email.opened`, `email.clicked` and a dozen others to the same
 * endpoint, and the only correct answer to an event we will never handle is the
 * 200 that stops the provider redelivering it for days. Same rule the payment
 * and the form webhook follow.
 */
export function parseResendDelivery(rawBody: Buffer): MailProviderEvent[] {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return [];
  }
  if (!isRecord(payload) || typeof payload.type !== 'string') {
    return [];
  }
  const data = isRecord(payload.data) ? payload.data : {};
  const verdict = verdictOf(payload.type, data);
  if (!verdict) {
    return [];
  }

  const occurredAt = dateOf(payload.created_at) ?? dateOf(data.created_at) ?? new Date();
  const messageId = typeof data.email_id === 'string' ? data.email_id : null;

  return recipientsOf(data).map((email) => ({
    kind: verdict.kind,
    email,
    permanent: verdict.permanent,
    occurredAt,
    detail: verdict.detail,
    messageId,
  }));
}

interface Verdict {
  kind: MailEventKind;
  permanent: boolean;
  detail: string | null;
}

/**
 * The provider's event name, read as a verdict about the address.
 *
 * `email.bounced` is the one that is not a constant: Resend reports a hard
 * refusal and a full mailbox through the same event, and only `bounce.type`
 * tells them apart. `Permanent` is the hard one — anything else will be retried
 * and must not be recorded as an address that rejects our mail, or a full
 * inbox on Monday would read as a dead address forever.
 */
function verdictOf(type: string, data: Record<string, unknown>): Verdict | null {
  switch (type) {
    case 'email.bounced': {
      const bounce = isRecord(data.bounce) ? data.bounce : {};
      return {
        kind: 'bounced',
        permanent: bounce.type === 'Permanent',
        detail: messageOf(bounce, data),
      };
    }
    case 'email.complained':
      return {
        kind: 'complained',
        permanent: true,
        detail: messageOf(isRecord(data.complaint) ? data.complaint : {}, data),
      };
    case 'email.suppressed':
      return {
        kind: 'suppressed',
        permanent: true,
        detail: messageOf(isRecord(data.suppressed) ? data.suppressed : {}, data),
      };
    case 'suppression.added':
      return { kind: 'suppressed', permanent: true, detail: messageOf(data, data) };
    case 'email.failed':
      return { kind: 'failed', permanent: false, detail: messageOf(isRecord(data.failed) ? data.failed : {}, data) };
    case 'email.delivery_delayed':
      return { kind: 'delayed', permanent: false, detail: messageOf(data, data) };
    case 'email.delivered':
      return { kind: 'delivered', permanent: false, detail: null };
    case 'suppression.removed':
      return { kind: 'unsuppressed', permanent: false, detail: null };
    default:
      return null;
  }
}

/**
 * Every address the event is about.
 *
 * `to` is an array on an email event and the whole payload is one address on a
 * suppression-list event, so both shapes are read. Our own mail is always
 * single-recipient; the loop is what keeps a manual send from the dashboard
 * from being half-recorded.
 */
function recipientsOf(data: Record<string, unknown>): string[] {
  const raw = data.to ?? data.email ?? data.address;
  const candidates = Array.isArray(raw) ? raw : [raw];
  const addresses = candidates
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normaliseAddress(value))
    .filter((value) => value.length > 0);
  return [...new Set(addresses)];
}

/** The one form an address is compared and stored in. */
export function normaliseAddress(email: string): string {
  // `Name <address>` is what a `from` looks like and what a dashboard send can
  // put in `to`; the address is the part that identifies the mailbox.
  const angled = /<([^>]+)>/.exec(email);
  return (angled?.[1] ?? email).trim().toLowerCase();
}

function messageOf(primary: Record<string, unknown>, fallback: Record<string, unknown>): string | null {
  const message = primary.message ?? fallback.message ?? primary.reason ?? primary.type;
  return typeof message === 'string' && message.trim().length > 0 ? message.trim().slice(0, MAX_DETAIL_LENGTH) : null;
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
