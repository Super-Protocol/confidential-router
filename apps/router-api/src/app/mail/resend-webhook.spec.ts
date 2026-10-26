import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseResendDelivery, verifyResendSignature } from './resend-webhook.js';

const SECRET = `whsec_${Buffer.from('a-sixteen-byte-key-at-least').toString('base64')}`;
const DELIVERY_ID = 'msg_2abcDEF';
const NOW = new Date('2026-10-26T12:00:00.000Z');

function sign(body: string, options: { secret?: string; at?: Date; id?: string } = {}): Record<string, string> {
  const { secret = SECRET, at = NOW, id = DELIVERY_ID } = options;
  const timestamp = Math.floor(at.getTime() / 1000).toString();
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { id, timestamp, signature: `v1,${signature}` };
}

describe('verifyResendSignature', () => {
  const body = JSON.stringify({ type: 'email.bounced' });

  it('accepts a delivery the provider signed', () => {
    expect(verifyResendSignature({ secret: SECRET, rawBody: Buffer.from(body), headers: sign(body), now: NOW })).toBe(
      true,
    );
  });

  it('accepts the secret written without its whsec_ prefix', () => {
    const bare = SECRET.slice('whsec_'.length);
    expect(verifyResendSignature({ secret: bare, rawBody: Buffer.from(body), headers: sign(body), now: NOW })).toBe(
      true,
    );
  });

  it('refuses a body that changed by one byte after it was signed', () => {
    const headers = sign(body);
    expect(verifyResendSignature({ secret: SECRET, rawBody: Buffer.from(`${body} `), headers, now: NOW })).toBe(false);
  });

  it('refuses a signature made with another secret', () => {
    const headers = sign(body, {
      secret: `whsec_${Buffer.from('a-different-sixteen-byte-key').toString('base64')}`,
    });
    expect(verifyResendSignature({ secret: SECRET, rawBody: Buffer.from(body), headers, now: NOW })).toBe(false);
  });

  it('refuses a replay of a delivery signed an hour ago', () => {
    const headers = sign(body, { at: new Date(NOW.getTime() - 3_600_000) });
    expect(verifyResendSignature({ secret: SECRET, rawBody: Buffer.from(body), headers, now: NOW })).toBe(false);
  });

  it('refuses a delivery with a header missing', () => {
    const headers = sign(body);
    expect(
      verifyResendSignature({
        secret: SECRET,
        rawBody: Buffer.from(body),
        headers: { ...headers, signature: undefined },
        now: NOW,
      }),
    ).toBe(false);
    expect(
      verifyResendSignature({
        secret: SECRET,
        rawBody: Buffer.from(body),
        headers: { ...headers, id: undefined },
        now: NOW,
      }),
    ).toBe(false);
    expect(
      verifyResendSignature({
        secret: SECRET,
        rawBody: Buffer.from(body),
        headers: { ...headers, timestamp: undefined },
        now: NOW,
      }),
    ).toBe(false);
  });

  it('accepts a header carrying several versioned signatures, as a key rotation sends', () => {
    const headers = sign(body);
    const withOld = { ...headers, signature: `v1,b3RoZXI= ${headers.signature}` };
    expect(verifyResendSignature({ secret: SECRET, rawBody: Buffer.from(body), headers: withOld, now: NOW })).toBe(
      true,
    );
  });

  it('refuses an entry of an unknown signature version', () => {
    const headers = sign(body);
    const v2 = { ...headers, signature: headers.signature.replace('v1,', 'v2,') };
    expect(verifyResendSignature({ secret: SECRET, rawBody: Buffer.from(body), headers: v2, now: NOW })).toBe(false);
  });
});

/** A payload in the shape the provider documents, minus the fields nothing reads. */
function delivery(type: string, data: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ type, created_at: '2026-10-20T16:02:19.000Z', data }));
}

describe('parseResendDelivery', () => {
  it('reads a suppressed send — the event SUP-551 is about', () => {
    const [event] = parseResendDelivery(
      delivery('email.suppressed', {
        email_id: '5676-1188',
        to: ['Alexey <AlexeyKheben@superprotocol.com>'],
        suppressed: { type: 'OnAccountSuppressionList', message: 'Resend has suppressed sending to this address' },
      }),
    );

    expect(event).toMatchObject({
      kind: 'suppressed',
      email: 'alexeykheben@superprotocol.com',
      permanent: true,
      messageId: '5676-1188',
    });
    expect(event?.detail).toContain('suppressed sending');
    expect(event?.occurredAt.toISOString()).toBe('2026-10-20T16:02:19.000Z');
  });

  it('reads a permanent bounce as a verdict on the address', () => {
    const [event] = parseResendDelivery(
      delivery('email.bounced', {
        to: ['nobody@example.com'],
        bounce: { type: 'Permanent', subType: 'General', message: 'The recipient does not exist.' },
      }),
    );

    expect(event).toMatchObject({ kind: 'bounced', permanent: true });
  });

  it('does not read a transient bounce as one', () => {
    const [event] = parseResendDelivery(
      delivery('email.bounced', {
        to: ['busy@example.com'],
        bounce: { type: 'Transient', subType: 'MailboxFull', message: 'The mailbox is full.' },
      }),
    );

    expect(event).toMatchObject({ kind: 'bounced', permanent: false });
  });

  it('reads a complaint, a delay, a failure and a delivery', () => {
    const kinds = [
      ['email.complained', {}],
      ['email.delivery_delayed', {}],
      ['email.failed', {}],
      ['email.delivered', {}],
    ] as const;

    const read = kinds.map(
      ([type, extra]) => parseResendDelivery(delivery(type, { to: ['a@example.com'], ...extra }))[0]?.kind,
    );

    expect(read).toEqual(['complained', 'delayed', 'failed', 'delivered']);
  });

  it('reads the suppression list being added to and cleared', () => {
    expect(parseResendDelivery(delivery('suppression.added', { email: 'a@example.com' }))[0]).toMatchObject({
      kind: 'suppressed',
      permanent: true,
    });
    expect(parseResendDelivery(delivery('suppression.removed', { email: 'a@example.com' }))[0]).toMatchObject({
      kind: 'unsuppressed',
    });
  });

  it('ignores the events this deployment does not act on, rather than failing them', () => {
    for (const type of ['email.sent', 'email.opened', 'email.clicked', 'domain.updated', 'contact.created']) {
      expect(parseResendDelivery(delivery(type, { to: ['a@example.com'] }))).toEqual([]);
    }
  });

  it('ignores a body that is not a delivery at all', () => {
    expect(parseResendDelivery(Buffer.from('not json'))).toEqual([]);
    expect(parseResendDelivery(Buffer.from('[]'))).toEqual([]);
    expect(parseResendDelivery(Buffer.from('{}'))).toEqual([]);
  });

  it('reads every recipient once, however the delivery spells them', () => {
    const events = parseResendDelivery(
      delivery('email.bounced', {
        to: ['One@example.com', 'Two <two@example.com>', 'one@example.com'],
        bounce: { type: 'Permanent' },
      }),
    );

    expect(events.map((event) => event.email)).toEqual(['one@example.com', 'two@example.com']);
  });
});
