import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseTypeformDelivery, verifyTypeformSignature } from './typeform.js';

const SECRET = 'typeform-webhook-secret';

/** A delivery shaped like Typeform's, with only the parts this code reads filled in. */
function delivery(overrides: { event_type?: string; form_response?: Record<string, unknown> } = {}): Buffer {
  const { form_response, ...rest } = overrides;
  return Buffer.from(
    JSON.stringify({
      event_id: '01H0000000000000000000',
      event_type: 'form_response',
      ...rest,
      form_response: {
        form_id: 'aBcDeF',
        token: 'submission-1',
        submitted_at: '2026-09-25T12:34:56Z',
        hidden: { t: 'signed-token' },
        definition: { id: 'aBcDeF', fields: [{ id: 'q1', title: 'How did it go?' }] },
        answers: [{ field: { id: 'q1' }, type: 'text', text: 'Fast, and I could verify it.' }],
        ...form_response,
      },
    }),
    'utf8',
  );
}

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('base64')}`;
}

describe('the delivery signature', () => {
  it('accepts a body Typeform signed', () => {
    const body = delivery();

    expect(verifyTypeformSignature(SECRET, body, sign(body))).toBe(true);
  });

  it('refuses a body that changed by one byte after it was signed', () => {
    const body = delivery();
    const header = sign(body);
    const tampered = Buffer.from(body.toString('utf8').replace('submission-1', 'submission-2'), 'utf8');

    expect(verifyTypeformSignature(SECRET, tampered, header)).toBe(false);
  });

  it('refuses a signature made with another secret', () => {
    const body = delivery();

    expect(verifyTypeformSignature(SECRET, body, sign(body, 'someone-elses-secret'))).toBe(false);
  });

  it.each([undefined, '', 'nonsense', 'sha1=abc', 'sha256=', 'sha256=!!!not-base64'])(
    'refuses the header %s',
    (header) => {
      expect(verifyTypeformSignature(SECRET, delivery(), header)).toBe(false);
    },
  );
});

describe('reading a delivery', () => {
  it('pulls out the submission id, the form, the token and the answers', () => {
    const parsed = parseTypeformDelivery(delivery());

    expect(parsed).toEqual({
      submissionId: 'submission-1',
      formId: 'aBcDeF',
      token: 'signed-token',
      submittedAt: new Date('2026-09-25T12:34:56Z'),
      answers: {
        answers: [{ field: { id: 'q1' }, type: 'text', text: 'Fast, and I could verify it.' }],
        fields: [{ id: 'q1', title: 'How did it go?' }],
      },
    });
  });

  it('never carries the hidden fields into what gets stored', () => {
    // The hidden fields hold a credential. A credential in an analytics table is
    // a credential in every backup of that table.
    expect(JSON.stringify(parseTypeformDelivery(delivery())?.answers)).not.toContain('signed-token');
  });

  it('ignores an event type that is not a submission, rather than failing it', () => {
    expect(parseTypeformDelivery(delivery({ event_type: 'form_ping' }))).toBeNull();
  });

  it.each([Buffer.from('not json', 'utf8'), Buffer.from('[]', 'utf8'), Buffer.from('{}', 'utf8')])(
    'ignores unreadable bytes',
    (body) => {
      expect(parseTypeformDelivery(body)).toBeNull();
    },
  );

  it('ignores a submission with no id, because there is nothing to deduplicate on', () => {
    expect(parseTypeformDelivery(delivery({ form_response: { token: undefined } }))).toBeNull();
  });

  it('reports no token when the form carried no hidden field', () => {
    expect(parseTypeformDelivery(delivery({ form_response: { hidden: undefined } }))?.token).toBeNull();
  });

  it('falls back to now when the provider sent an unreadable timestamp', () => {
    const parsed = parseTypeformDelivery(delivery({ form_response: { submitted_at: 'yesterday' } }));

    expect(parsed?.submittedAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });
});
