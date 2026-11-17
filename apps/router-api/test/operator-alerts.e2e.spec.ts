import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './app-harness.js';
import { type ConsoleSession, graphql, signIn } from './console.js';

/**
 * The outbound path for an alert, end to end (SUP-535).
 *
 * The one thing SUP-517 could not demonstrate: that an outage reaches somebody.
 * A log line is an alert only where something watches the log, and this
 * deployment has nothing watching it — both production outages so far were found
 * by a person stumbling over them. So the assertion here is the one the issue
 * asks for: a message, rendered, addressed, accepted by the transport.
 *
 * `CapturingMailer` stands in for the provider, which is exactly the seam the
 * sign-in mail is tested at: everything above it — the recipient resolution, the
 * rate limit, the rendering — runs for real.
 */

const OPERATOR = 'ops@example.test';
const MEMBER = 'member@example.test';
const ONCALL = 'oncall@example.test';

const SEND_TEST = 'mutation { sendOperatorAlertTest { sent delivered failed skipped } }';

let harness: Harness;

async function start(env: Record<string, string> = {}): Promise<void> {
  harness = await createHarness({
    env: { CR_API_AUTH__ADMIN_EMAILS: OPERATOR, ...env },
  });
}

async function operator(): Promise<ConsoleSession> {
  return signIn(harness, OPERATOR);
}

afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as Harness;
});

describe('the alert channel an operator can prove', () => {
  beforeEach(async () => {
    await start();
  });

  it('sends a real message to the operators the deployment already names', async () => {
    const body = await graphql(await operator(), SEND_TEST);

    expect(body.data?.sendOperatorAlertTest).toEqual({ sent: true, delivered: 1, failed: 0, skipped: null });
    // The fallback is the design: no new deploy parameter, so the channel works on
    // the deployment that is already running — the one the outage happens on.
    const sent = harness.mailer.ofKind('operator-alert');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(OPERATOR);
  });

  it('writes a message nobody can mistake for an incident six weeks later', async () => {
    await graphql(await operator(), SEND_TEST);

    const [message] = harness.mailer.ofKind('operator-alert');
    expect(message.subject).toBe('[Confidential Router] Alert channel test');
    expect(message.text).toContain('Nothing is wrong');
    expect(message.text).toContain(OPERATOR);
  });

  it('is refused to a signed-in non-admin: it writes to every operator address', async () => {
    const body = await graphql(await signIn(harness, MEMBER), SEND_TEST);

    expect(body.errors?.[0].extensions.code).toBe('FORBIDDEN');
    expect(harness.mailer.ofKind('operator-alert')).toHaveLength(0);
  });

  it('reports the channel on /health, as a count and never an address', async () => {
    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);

    // `ready`, not `ok`: nothing has been raised yet, and the difference is the
    // whole point — "a channel is configured" is not "a human was written to".
    expect(response.body.alerts).toEqual({ state: 'ready', recipients: 1 });
    expect(JSON.stringify(response.body.alerts)).not.toContain(OPERATOR);
  });

  it('reports ok on /health once a message has gone out', async () => {
    await graphql(await operator(), SEND_TEST);

    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);
    expect(response.body.alerts).toMatchObject({ state: 'ok', recipients: 1 });
    expect(response.body.alerts.lastAttemptAt).toMatch(/^\d{4}-/);
  });
});

describe('a deployment that cannot alert says so', () => {
  it('reads unconfigured when nobody is named, which is what looks like quiet', async () => {
    await start({ CR_API_AUTH__ADMIN_EMAILS: '' });

    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);

    // The pair that matters on a live deployment: `externalEndpoints.status:
    // outage` beside `alerts.state: unconfigured` says nobody has been told.
    expect(response.body.alerts).toEqual({ state: 'unconfigured', recipients: 0 });
    // And it must not take the deployment out of rotation for it.
    expect(response.body.status).toBe('ok');
  });

  it('reads disabled when the outbound path is switched off', async () => {
    await start({ CR_API_ALERTS__EMAIL: 'false' });

    const response = await request(harness.app.getHttpServer()).get('/health').expect(200);
    expect(response.body.alerts.state).toBe('disabled');
  });

  it('answers the admin test honestly rather than claiming a send', async () => {
    await start({ CR_API_AUTH__ADMIN_EMAILS: OPERATOR, CR_API_ALERTS__EMAIL: 'false' });

    const body = await graphql(await operator(), SEND_TEST);

    expect(body.data?.sendOperatorAlertTest).toEqual({
      sent: false,
      delivered: 0,
      failed: 0,
      skipped: 'NO_PROVIDER',
    });
    expect(harness.mailer.ofKind('operator-alert')).toHaveLength(0);
  });
});

describe('who the alert is addressed to', () => {
  it('prefers alerts.emails over the admin list, and writes to each separately', async () => {
    await start({ CR_API_ALERTS__EMAILS: `${ONCALL},second@example.test` });

    const body = await graphql(await operator(), SEND_TEST);

    expect(body.data?.sendOperatorAlertTest).toMatchObject({ sent: true, delivered: 2 });
    // One envelope each: a provider that refuses one address refuses the whole
    // envelope, and the operator who would then not be told is the one whose
    // address was fine.
    expect(harness.mailer.ofKind('operator-alert').map((message) => message.to)).toEqual([
      ONCALL,
      'second@example.test',
    ]);
  });
});
