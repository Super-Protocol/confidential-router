import type { ConfigType } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { routerConfig } from '../config.js';
import { RouterConfigSchema } from '../config.schema.js';
import type { MailService, OperatorAlert } from '../mail/mail.service.js';
import { OperatorAlertsService } from './operator-alerts.service.js';

/**
 * The outbound half of an alert (SUP-535).
 *
 * The property under test is not "a mail was rendered" — it is the one the issue
 * is about: whether a human was written to, and whether the deployment can tell
 * the difference between that and a channel that merely exists. So every case
 * here asserts on recipients, on what `status()` admits, or on what survives a
 * mail server that is down.
 */

const ALERT: OperatorAlert = {
  title: 'External endpoint “qwen” has stopped serving',
  summary: 'Every model on it is refused.',
  facts: [['Endpoint', 'qwen']],
  action: 'Check the upstream.',
};

interface Sent {
  recipients: string[];
  alert: OperatorAlert;
}

function mailer(options: { enabled?: boolean; refuse?: boolean } = {}): { mail: MailService; sent: Sent[] } {
  const sent: Sent[] = [];
  const mail = {
    enabled: options.enabled ?? true,
    sendOperatorAlert: vi.fn(async (alert: OperatorAlert, recipients: readonly string[]) => {
      sent.push({ alert, recipients: [...recipients] });
      return options.refuse
        ? {
            attempted: recipients.length,
            delivered: [],
            failed: [{ to: recipients[0], reason: 'unreachable' }],
            skipped: null,
          }
        : { attempted: recipients.length, delivered: [...recipients], failed: [], skipped: null };
    }),
  } as unknown as MailService;
  return { mail, sent };
}

function config(overrides: Record<string, unknown> = {}): ConfigType<typeof routerConfig> {
  return RouterConfigSchema.parse({
    auth: { secret: 'a'.repeat(32), adminEmails: ['ops@example.test'] },
    ...overrides,
  }) as ConfigType<typeof routerConfig>;
}

describe('who an alert reaches', () => {
  it('writes to auth.adminEmails when alerts.emails names nobody', async () => {
    // The whole design: a channel that needed a new deploy parameter would be
    // unset on the deployment the outage happens on.
    const mail = mailer();
    const service = new OperatorAlertsService(config(), mail.mail);

    await service.raise(ALERT);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].recipients).toEqual(['ops@example.test']);
  });

  it('prefers alerts.emails over the admin list when it names anybody', async () => {
    const mail = mailer();
    const service = new OperatorAlertsService(config({ alerts: { emails: ['oncall@example.test'] } }), mail.mail);

    await service.raise(ALERT);

    expect(mail.sent[0].recipients).toEqual(['oncall@example.test']);
  });

  it('says so on /health when it has nobody to write to, rather than looking quiet', async () => {
    const mail = mailer();
    const service = new OperatorAlertsService(config({ auth: { secret: 'a'.repeat(32), adminEmails: [] } }), mail.mail);

    expect(await service.raise(ALERT)).toBeNull();
    expect(mail.sent).toHaveLength(0);
    // The state SUP-535 exists to make visible: detecting outages, telling nobody.
    expect(service.status()).toEqual({ state: 'unconfigured', recipients: 0 });
  });

  it('is disabled, not unconfigured, when the deployment has no mail provider at all', async () => {
    const mail = mailer({ enabled: false });
    const service = new OperatorAlertsService(config(), mail.mail);

    expect(await service.raise(ALERT)).toBeNull();
    expect(service.status().state).toBe('disabled');
  });

  it('is disabled when alerts.email is off, and the log line is still the record', async () => {
    const mail = mailer();
    const service = new OperatorAlertsService(config({ alerts: { email: false } }), mail.mail);

    expect(await service.raise(ALERT)).toBeNull();
    expect(service.status().state).toBe('disabled');
  });
});

describe('what the channel admits about itself', () => {
  it('reports ok once an alert reached somebody', async () => {
    const service = new OperatorAlertsService(config(), mailer().mail);

    expect(service.status().state).toBe('ready');
    await service.raise(ALERT);

    expect(service.status().state).toBe('ok');
    expect(service.status().lastAttemptAt).toBeDefined();
  });

  it('reports failing when the mail server refused every address', async () => {
    const service = new OperatorAlertsService(config(), mailer({ refuse: true }).mail);

    await service.raise(ALERT);

    // Not `ok`: an alert the provider refused is an alert nobody read, and this
    // is the one line that distinguishes the two from outside the cluster.
    expect(service.status().state).toBe('failing');
  });

  it('never rejects when the mail path throws, because the outage is already recorded', async () => {
    const mail = {
      enabled: true,
      sendOperatorAlert: vi.fn().mockRejectedValue(new Error('smtp exploded')),
    } as unknown as MailService;
    const service = new OperatorAlertsService(config(), mail);

    // The caller is a background pass that has already written the outage to the
    // log, the timeline and /health. A throw here would turn a detected outage
    // into an unhandled rejection.
    await expect(service.raise(ALERT)).resolves.toBeNull();
    expect(service.status().state).toBe('failing');
  });
});

describe('the rate limit', () => {
  it('sends one alert and suppresses the next inside alerts.minInterval', async () => {
    const mail = mailer();
    const service = new OperatorAlertsService(config({ alerts: { minInterval: '15m' } }), mail.mail);
    const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 26, 10, minutes));

    await service.raise(ALERT, at(0));
    await service.raise(ALERT, at(5));

    expect(mail.sent).toHaveLength(1);
    expect(service.status().suppressed).toBe(1);
  });

  it('sends again past the interval, and says how many it swallowed', async () => {
    const mail = mailer();
    const service = new OperatorAlertsService(config({ alerts: { minInterval: '15m' } }), mail.mail);
    const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 26, 10, minutes));

    await service.raise(ALERT, at(0));
    await service.raise(ALERT, at(5));
    await service.raise(ALERT, at(9));
    await service.raise(ALERT, at(20));

    expect(mail.sent).toHaveLength(2);
    // A suppressed alert nobody is told about is a suppressed alert nobody knows
    // about: "it flapped twice more" is what separates a one-off from a rolling
    // upstream.
    expect(Object.fromEntries(mail.sent[1].alert.facts)).toMatchObject({
      'Alerts suppressed since the last message': '2',
    });
    expect(service.status().suppressed).toBeUndefined();
  });

  it('lets an urgent alert — the recovery — past the interval', async () => {
    const mail = mailer();
    const service = new OperatorAlertsService(config({ alerts: { minInterval: '15m' } }), mail.mail);
    const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 26, 10, minutes));

    await service.raise(ALERT, at(0));
    await service.raise({ ...ALERT, title: 'is serving again' }, at(2), { urgent: true });

    // An operator who was woken is owed the "it is back" line; withholding it to
    // protect the mailbox leaves them chasing an outage that is over.
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1].alert.title).toBe('is serving again');
  });

  it('is armed by a message that landed, not by one that was refused', async () => {
    const mail = mailer({ refuse: true });
    const service = new OperatorAlertsService(config({ alerts: { minInterval: '15m' } }), mail.mail);
    const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 26, 10, minutes));

    await service.raise(ALERT, at(0));
    await service.raise(ALERT, at(1));

    // A send that reached nobody put nothing in a mailbox, so there is nothing to
    // protect. Arming on it would spend the next quarter-hour's alerting budget on
    // a message that does not exist — one transient refusal silencing the window
    // that matters most.
    expect(mail.sent).toHaveLength(2);
    expect(service.status().suppressed).toBeUndefined();
  });

  it('keeps the suppressed count when the message that would have reported it failed', async () => {
    const sent: Sent[] = [];
    let refuse = false;
    const mail = {
      enabled: true,
      sendOperatorAlert: vi.fn(async (alert: OperatorAlert, recipients: readonly string[]) => {
        sent.push({ alert, recipients: [...recipients] });
        return refuse
          ? {
              attempted: 1,
              delivered: [],
              failed: [{ to: recipients[0], reason: 'unreachable' as const }],
              skipped: null,
            }
          : { attempted: 1, delivered: [...recipients], failed: [], skipped: null };
      }),
    } as unknown as MailService;
    const service = new OperatorAlertsService(config({ alerts: { minInterval: '15m' } }), mail);
    const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 26, 10, minutes));

    await service.raise(ALERT, at(0));
    await service.raise(ALERT, at(5));
    refuse = true;
    await service.raise(ALERT, at(20));
    refuse = false;
    await service.raise(ALERT, at(21));

    // The count belongs to whichever message actually carries it out. The refused
    // one at :20 did not, so the one at :21 still has to say "1".
    expect(Object.fromEntries(sent.at(-1)?.alert.facts ?? [])).toMatchObject({
      'Alerts suppressed since the last message': '1',
    });
  });

  it('sends every alert when the interval is disabled', async () => {
    const mail = mailer();
    const service = new OperatorAlertsService(config({ alerts: { minInterval: 0 } }), mail.mail);

    await service.raise(ALERT, new Date(0));
    await service.raise(ALERT, new Date(0));

    expect(mail.sent).toHaveLength(2);
  });
});

describe('the operator’s own test', () => {
  it('sends one message, past the interval, naming who asked', async () => {
    const mail = mailer();
    const service = new OperatorAlertsService(config({ alerts: { minInterval: '15m' } }), mail.mail);

    await service.raise(ALERT, new Date(Date.UTC(2026, 9, 26, 10, 0)));
    const delivery = await service.sendTest('ops@example.test', new Date(Date.UTC(2026, 9, 26, 10, 1)));

    expect(delivery.delivered).toEqual(['ops@example.test']);
    expect(mail.sent).toHaveLength(2);
    expect(Object.fromEntries(mail.sent[1].alert.facts)).toMatchObject({ 'Raised by': 'ops@example.test' });
    // It has to be unmistakable in an inbox six weeks later.
    expect(mail.sent[1].alert.summary).toContain('Nothing is wrong');
  });

  it('reports why nothing was sent rather than claiming it was', async () => {
    const withoutProvider = new OperatorAlertsService(config(), mailer({ enabled: false }).mail);
    expect(await withoutProvider.sendTest('ops@example.test')).toMatchObject({ skipped: 'no_provider' });

    const withoutRecipients = new OperatorAlertsService(
      config({ auth: { secret: 'a'.repeat(32), adminEmails: [] } }),
      mailer().mail,
    );
    expect(await withoutRecipients.sendTest('ops@example.test')).toMatchObject({ skipped: 'no_recipients' });
  });
});
