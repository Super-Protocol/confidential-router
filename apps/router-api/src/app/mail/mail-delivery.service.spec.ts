import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource } from '../../../test/seed.js';
import { MailAddressState } from '../db/entities/mail-address-state.entity.js';
import { User } from '../db/entities/user.entity.js';
import { MailDeliveryService } from './mail-delivery.service.js';
import type { MailEventKind, MailProviderEvent } from './resend-webhook.js';

let dataSource: DataSource;
let deliveries: MailDeliveryService;

beforeEach(async () => {
  dataSource = await createTestDataSource();
  deliveries = new MailDeliveryService(dataSource.getRepository(MailAddressState), dataSource.getRepository(User));
});

afterEach(async () => {
  await dataSource.destroy();
});

const SUPPRESSED_AT = new Date('2026-10-20T16:02:19.000Z');

function event(kind: MailEventKind, overrides: Partial<MailProviderEvent> = {}): MailProviderEvent {
  return {
    kind,
    email: 'alexeykheben@superprotocol.com',
    permanent: kind === 'suppressed' || kind === 'complained',
    occurredAt: SUPPRESSED_AT,
    detail: null,
    messageId: null,
    ...overrides,
  };
}

async function rowFor(email: string): Promise<MailAddressState | null> {
  return dataSource.getRepository(MailAddressState).findOne({ where: { email } });
}

describe('recording what the provider reports', () => {
  it('writes down an address the provider is dropping mail to', async () => {
    await deliveries.record(event('suppressed', { detail: 'on the suppression list' }), 'msg_1');

    expect(await rowFor('alexeykheben@superprotocol.com')).toMatchObject({
      state: 'rejecting',
      reason: 'suppressed',
      detail: 'on the suppression list',
      failures: 1,
      rejectingSince: SUPPRESSED_AT,
    });
  });

  it('keys the row by the normalised address, however the event spelled it', async () => {
    await deliveries.record(event('complained', { email: '  AlexeyKheben@SuperProtocol.com ' }), 'msg_1');

    expect(await rowFor('alexeykheben@superprotocol.com')).toMatchObject({ reason: 'complained' });
  });

  /** The three dead sign-in codes in SUP-551: one address, three attempts, three events. */
  it('counts each dropped message, and holds the time the trouble started', async () => {
    const later = new Date('2026-10-20T16:04:15.000Z');
    await deliveries.record(event('suppressed'), 'msg_1');
    await deliveries.record(event('suppressed', { occurredAt: later }), 'msg_2');
    await deliveries.record(event('suppressed', { occurredAt: later }), 'msg_3');

    expect(await rowFor('alexeykheben@superprotocol.com')).toMatchObject({
      failures: 3,
      rejectingSince: SUPPRESSED_AT,
      lastEventAt: later,
    });
  });

  it('counts a redelivery of the same message once', async () => {
    await deliveries.record(event('suppressed'), 'msg_1');
    await deliveries.record(event('suppressed'), 'msg_1');

    expect(await rowFor('alexeykheben@superprotocol.com')).toMatchObject({ failures: 1 });
  });

  it('treats a permanent bounce as a verdict and a transient one as a delay', async () => {
    await deliveries.record(event('bounced', { permanent: true }), 'msg_1');
    expect(await rowFor('alexeykheben@superprotocol.com')).toMatchObject({ state: 'rejecting' });

    await deliveries.record(event('bounced', { email: 'busy@example.com', permanent: false }), 'msg_2');
    expect(await rowFor('busy@example.com')).toMatchObject({ state: 'delayed', rejectingSince: null });
  });

  it('clears an address the provider says it delivered to again', async () => {
    await deliveries.record(event('suppressed'), 'msg_1');
    await deliveries.record(event('delivered'), 'msg_2');

    expect(await rowFor('alexeykheben@superprotocol.com')).toMatchObject({
      state: 'delivering',
      reason: null,
      failures: 0,
      rejectingSince: null,
    });
  });

  it('clears one the provider took off its suppression list', async () => {
    await deliveries.record(event('suppressed'), 'msg_1');
    await deliveries.record(event('unsuppressed'), 'msg_2');

    expect(await rowFor('alexeykheben@superprotocol.com')).toMatchObject({ state: 'delivering' });
  });

  /**
   * Good news about an address nothing has ever complained about is nothing to
   * write: the table is a list of addresses with a problem, not a list of
   * everyone the deployment has mailed.
   */
  it('writes no row for a delivery that simply worked', async () => {
    await deliveries.record(event('delivered', { email: 'fine@example.com' }), 'msg_1');

    expect(await rowFor('fine@example.com')).toBeNull();
    expect(await deliveries.undeliverable()).toEqual({ addresses: 0 });
  });
});

describe('answering about one address', () => {
  it('says unknown for an address nothing has gone wrong with', async () => {
    expect(await deliveries.verdictOf('nobody@example.com')).toEqual({ state: 'unknown' });
  });

  it('says rejecting for one whose mail is being dropped, and when it started', async () => {
    await deliveries.record(event('suppressed'), 'msg_1');

    expect(await deliveries.verdictOf('AlexeyKheben@superprotocol.com')).toEqual({
      state: 'rejecting',
      since: SUPPRESSED_AT,
    });
  });
});

describe('the operator’s count', () => {
  it('counts only the addresses that are being dropped, and dates the most recent', async () => {
    const later = new Date('2026-10-21T09:00:00.000Z');
    await deliveries.record(event('suppressed'), 'msg_1');
    await deliveries.record(event('complained', { email: 'second@example.com', occurredAt: later }), 'msg_2');
    await deliveries.record(event('delayed', { email: 'busy@example.com' }), 'msg_3');

    expect(await deliveries.undeliverable()).toEqual({ addresses: 2, lastAt: later.toISOString() });
  });

  it('drops back to zero once the addresses recover', async () => {
    await deliveries.record(event('suppressed'), 'msg_1');
    await deliveries.record(event('delivered'), 'msg_2');

    expect(await deliveries.undeliverable()).toEqual({ addresses: 0 });
  });
});
