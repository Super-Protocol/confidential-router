import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './app-harness.js';
import { anonymous, expectData } from './console.js';

/**
 * What the mail provider says after it accepted a message, end to end (SUP-551).
 *
 * Every case boots the real application, because the property that matters is a
 * property of the wiring: the delivery is authenticated by an HMAC over the
 * *raw* bytes, which only holds if `bootstrap.ts` mounted the raw body parser
 * on this path ahead of the JSON one — and the route has to be reachable at
 * all, which means being registered before `V1FallbackController` claims
 * everything under `/v1`.
 */

const SECRET = `whsec_${Buffer.from('e2e-mail-webhook-secret-32-bytes').toString('base64')}`;
const WEBHOOK_PATH = '/v1/webhooks/resend';
const SUPPRESSED = 'alexeykheben@superprotocol.com';

const MAIL_STATE = `
  query MailState($email: String!) {
    signInMailState(email: $email) { state since }
  }
`;

let harness: Harness;

afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as Harness;
});

async function mailHarness(env: Record<string, string> = {}): Promise<Harness> {
  harness = await createHarness({ env: { CR_API_MAIL__WEBHOOK_SECRET: SECRET, ...env } });
  return harness;
}

/** A delivery signed the way the provider signs one. */
function deliver(body: unknown, options: { secret?: string; at?: Date } = {}) {
  const payload = JSON.stringify(body);
  const id = `msg_${randomUUID()}`;
  const timestamp = Math.floor((options.at ?? new Date()).getTime() / 1000).toString();
  const key = Buffer.from((options.secret ?? SECRET).slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');

  return request(harness.app.getHttpServer())
    .post(WEBHOOK_PATH)
    .set('content-type', 'application/json')
    .set('svix-id', id)
    .set('svix-timestamp', timestamp)
    .set('svix-signature', `v1,${signature}`)
    .send(payload);
}

function suppressed(email = SUPPRESSED) {
  return {
    type: 'email.suppressed',
    created_at: '2026-10-20T16:02:19.000Z',
    data: {
      email_id: '5676-1188',
      to: [email],
      suppressed: {
        type: 'OnAccountSuppressionList',
        message: 'Resend has suppressed sending to this address because it is on the account-level suppression list',
      },
    },
  };
}

describe('the mail provider’s webhook', () => {
  it('records an address the provider is dropping mail to', async () => {
    await mailHarness();

    await deliver(suppressed()).expect(200).expect({ recorded: 1 });

    const health = await request(harness.app.getHttpServer()).get('/health').expect(200);
    expect(health.body.mail.undeliverable).toEqual({
      addresses: 1,
      lastAt: '2026-10-20T16:02:19.000Z',
    });
  });

  /**
   * The signature covers the bytes the provider sent. If the JSON parser ran
   * first, the body the route verifies is a reserialisation of them and every
   * real delivery fails a signature that was never wrong — the failure this
   * whole suite exists to catch.
   */
  it('verifies the bytes the provider sent, not a reparse of them', async () => {
    await mailHarness();

    // Whitespace no reserialisation would reproduce: the signature still holds.
    const payload = `${JSON.stringify(suppressed())}\n`;
    const id = 'msg_whitespace';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64');
    const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');

    await request(harness.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set('content-type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', timestamp)
      .set('svix-signature', `v1,${signature}`)
      .send(payload)
      .expect(200)
      .expect({ recorded: 1 });
  });

  it('refuses a delivery signed with another secret', async () => {
    await mailHarness();

    await deliver(suppressed(), {
      secret: `whsec_${Buffer.from('a-forgers-secret-32-bytes-long!!').toString('base64')}`,
    }).expect(401);

    const health = await request(harness.app.getHttpServer()).get('/health').expect(200);
    expect(health.body.mail.undeliverable.addresses).toBe(0);
  });

  it('refuses a replay of a delivery signed an hour ago', async () => {
    await mailHarness();

    await deliver(suppressed(), { at: new Date(Date.now() - 3_600_000) }).expect(401);
  });

  it('answers an event it does not act on with a 200, so the provider stops resending it', async () => {
    await mailHarness();

    await deliver({ type: 'email.opened', data: { to: [SUPPRESSED] } })
      .expect(200)
      .expect({ recorded: 0 });
  });

  it('is not there at all on a deployment that configured no secret', async () => {
    harness = await createHarness();

    await deliver(suppressed()).expect(404);
  });

  it('clears the address once the provider delivers to it again', async () => {
    await mailHarness();

    await deliver(suppressed()).expect(200);
    await deliver({
      type: 'email.delivered',
      created_at: '2026-10-21T10:00:00.000Z',
      data: { email_id: '5676-1200', to: [SUPPRESSED] },
    }).expect(200);

    const health = await request(harness.app.getHttpServer()).get('/health').expect(200);
    expect(health.body.mail.undeliverable.addresses).toBe(0);
  });
});

describe('what the sign-in screen may say about an address', () => {
  it('tells an unauthenticated visitor that mail to the address is being dropped', async () => {
    await mailHarness();
    await deliver(suppressed()).expect(200);

    const data = await expectData(anonymous(harness), MAIL_STATE, { email: SUPPRESSED });

    expect(data.signInMailState).toEqual({ state: 'REJECTING', since: '2026-10-20T16:02:19.000Z' });
  });

  /**
   * The answer is about the mailbox and never about the account, which is what
   * makes it safe to give to a stranger: an address with an account and one
   * without answer identically.
   */
  it('says the same for every address nothing has gone wrong with', async () => {
    await mailHarness();

    for (const email of ['nobody@example.com', SUPPRESSED]) {
      const data = await expectData(anonymous(harness), MAIL_STATE, { email });
      expect(data.signInMailState).toEqual({ state: 'UNKNOWN', since: null });
    }
  });

  it('spends a budget, so the query cannot be walked down a list of addresses', async () => {
    await mailHarness({ CR_API_MAIL__STATE_LOOKUPS_PER_MINUTE: '2' });
    const session = anonymous(harness);

    await expectData(session, MAIL_STATE, { email: 'a@example.com' });
    await expectData(session, MAIL_STATE, { email: 'b@example.com' });

    const refused = await request(harness.app.getHttpServer())
      .post('/graphql')
      .send({ query: MAIL_STATE, variables: { email: 'c@example.com' } })
      .expect(200);

    expect(refused.body.errors?.[0]?.extensions?.code).toBe('TOO_MANY_REQUESTS');
  });
});
