import { createHmac, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Catalog, createTestDataSource, seedCatalog, seedGeneration, testConfig } from '../../../test/seed.js';
import { LedgerService } from '../billing/ledger.service.js';
import type { RouterConfig } from '../config.js';
import { CreditTransaction } from '../db/entities/credit-transaction.entity.js';
import { FeedbackSubmission } from '../db/entities/feedback-submission.entity.js';
import { InviteCode } from '../db/entities/invite-code.entity.js';
import { InviteRedemption } from '../db/entities/invite-redemption.entity.js';
import { Workspace } from '../db/entities/workspace.entity.js';
import { FeedbackSignatureError } from './feedback.errors.js';
import { FeedbackService } from './feedback.service.js';
import type { FeedbackAnalytics, FeedbackGrantAppliedEvent } from './feedback-analytics.js';
import { FeedbackEligibilityService } from './feedback-eligibility.service.js';
import { FEEDBACK_GRANT_REFERENCE, FeedbackGrantRecorder } from './feedback-grant.recorder.js';
import { issueFeedbackToken } from './feedback-token.js';

/**
 * Eligibility and the constraints, executed.
 *
 * Every refusal is asserted twice — the outcome the caller sees and the state of
 * the database afterwards — because a webhook that reported "refused" while
 * leaving credit behind would pass the first assertion alone.
 */

const FORM_URL = 'https://form.example/to/aBcDeF';
const WEBHOOK_SECRET = 'webhook-secret-for-tests';
const GRANT = 100_000_000;
const FIRST_GRANT_CAMPAIGN = 'launch-2026-10-devs';

let dataSource: DataSource;
let config: RouterConfig;
let feedback: FeedbackService;
let captured: FeedbackGrantAppliedEvent[];
let catalog: Catalog;

const analytics: FeedbackAnalytics = {
  grantApplied: (event) => {
    captured.push(event);
  },
};

beforeEach(async () => {
  dataSource = await createTestDataSource();
  config = testConfig({
    CR_API_FEEDBACK__FORM__URL: FORM_URL,
    CR_API_FEEDBACK__FORM__WEBHOOK_SECRET: WEBHOOK_SECRET,
    CR_API_FEEDBACK__MIN_METERED_TOKENS: '1000',
  });
  captured = [];
  feedback = new FeedbackService(
    config,
    new FeedbackEligibilityService(dataSource, config),
    new FeedbackGrantRecorder(dataSource, new LedgerService(dataSource, config), analytics),
  );
  catalog = await seedCatalog(dataSource);
});

afterEach(async () => {
  await dataSource.destroy();
});

interface Account {
  userId: string;
  workspaceId: string;
}

/**
 * An account that redeemed a first grant, spent it, and is therefore exactly the
 * one the offer exists for. Each `seed` option removes one of those conditions.
 */
async function seedAccount(
  seed: { balanceMicros?: number; tokens?: number; firstGrant?: boolean } = {},
): Promise<Account> {
  const userId = randomUUID();
  const workspaceId = catalog.workspaceId;

  await dataSource.getRepository(Workspace).update({ id: workspaceId }, { balanceMicros: seed.balanceMicros ?? 0 });

  if (seed.firstGrant !== false) {
    const codeId = randomUUID();
    await dataSource.getRepository(InviteCode).insert({
      id: codeId,
      code: `CODE${randomUUID().replace(/\D/g, '').slice(0, 8).padEnd(8, '9')}`,
      grantMicros: GRANT,
      campaign: FIRST_GRANT_CAMPAIGN,
      maxRedemptions: 1,
      redemptionCount: 1,
      expiresAt: null,
      disabledAt: null,
      note: null,
      createdAt: new Date(),
    });
    await dataSource.getRepository(InviteRedemption).insert({
      id: randomUUID(),
      inviteCodeId: codeId,
      userId,
      workspaceId,
      creditTransactionId: randomUUID(),
      ipHash: null,
      userAgentHash: null,
      redeemedAt: new Date(),
    });
  }

  const tokens = seed.tokens ?? 50_000;
  if (tokens > 0) {
    await seedGeneration(dataSource, catalog, {
      createdAt: new Date(),
      promptTokens: Math.ceil(tokens / 2),
      completionTokens: Math.floor(tokens / 2),
    });
  }

  return { userId, workspaceId };
}

/** The bytes and the header Typeform would have sent for one submission. */
function submission(
  account: Account,
  options: { submissionId?: string; token?: string; secret?: string; issuedAt?: number } = {},
): { body: Buffer; signature: string } {
  const token =
    options.token ??
    issueFeedbackToken(config.auth.secret, {
      userId: account.userId,
      workspaceId: account.workspaceId,
      issuedAt: options.issuedAt ?? Date.now(),
    });
  const body = Buffer.from(
    JSON.stringify({
      event_id: randomUUID(),
      event_type: 'form_response',
      form_response: {
        form_id: 'aBcDeF',
        token: options.submissionId ?? 'submission-1',
        submitted_at: '2026-09-25T12:34:56Z',
        hidden: { t: token },
        definition: { id: 'aBcDeF', fields: [{ id: 'q1', title: 'How did it go?' }] },
        answers: [{ field: { id: 'q1' }, type: 'text', text: 'It was fast.' }],
      },
    }),
    'utf8',
  );
  const secret = options.secret ?? WEBHOOK_SECRET;
  return { body, signature: `sha256=${createHmac('sha256', secret).update(body).digest('base64')}` };
}

function deliver(account: Account, options: Parameters<typeof submission>[1] = {}) {
  const { body, signature } = submission(account, options);
  return feedback.handleDelivery(body, signature);
}

async function balance(): Promise<number> {
  return (await dataSource.getRepository(Workspace).findOneByOrFail({ id: catalog.workspaceId })).balanceMicros;
}

/**
 * `data-model.md` invariant 3, which the second grant must not break either.
 *
 * Exact rather than relative, because `seedAccount` leaves the workspace at zero:
 * every micro-USD it holds afterwards has to have come from a ledger row.
 */
async function assertBalanceMatchesLedger(): Promise<void> {
  const entries = await dataSource.getRepository(CreditTransaction).findBy({ workspaceId: catalog.workspaceId });
  expect(await balance()).toBe(entries.reduce((total, entry) => total + entry.amountMicros, 0));
}

describe('who gets offered the second grant', () => {
  it('offers it to an account that spent its first grant and used it', async () => {
    const account = await seedAccount();

    const offer = await feedback.offerFor(account.userId);

    expect(offer.eligibility).toEqual({ eligible: true, workspaceId: account.workspaceId, grantMicros: GRANT });
    expect(offer.formUrl).toMatch(new RegExp(`^${FORM_URL}\\?t=`));
    expect(offer.granted).toBeNull();
  });

  it('does not offer it to an account that never redeemed a first grant', async () => {
    const account = await seedAccount({ firstGrant: false });

    expect(await feedback.offerFor(account.userId)).toMatchObject({
      eligibility: { eligible: false, reason: 'no_first_grant' },
      formUrl: null,
    });
  });

  it('does not offer it while there is still credit left', async () => {
    const account = await seedAccount({ balanceMicros: 40_000_000 });

    expect(await feedback.offerFor(account.userId)).toMatchObject({
      eligibility: { eligible: false, reason: 'balance_healthy' },
      formUrl: null,
    });
  });

  it('does not offer it to an account that never sent a request', async () => {
    const account = await seedAccount({ tokens: 0 });

    expect(await feedback.offerFor(account.userId)).toMatchObject({
      eligibility: { eligible: false, reason: 'no_usage' },
      formUrl: null,
    });
  });

  it('does not offer it twice', async () => {
    const account = await seedAccount();
    await deliver(account);

    const offer = await feedback.offerFor(account.userId);

    expect(offer.eligibility).toMatchObject({ eligible: false, reason: 'already_granted' });
    expect(offer.formUrl).toBeNull();
    expect(offer.granted?.grantMicros).toBe(GRANT);
  });

  it('is inert on a deployment with no form configured', async () => {
    const bare = testConfig();
    const service = new FeedbackService(
      bare,
      new FeedbackEligibilityService(dataSource, bare),
      new FeedbackGrantRecorder(dataSource, new LedgerService(dataSource, bare), analytics),
    );
    const account = await seedAccount();

    expect(service.configured).toBe(false);
    expect(await service.offerFor(account.userId)).toMatchObject({
      eligibility: { eligible: false, reason: 'disabled' },
      formUrl: null,
    });
  });
});

describe('a submission that has earned the grant', () => {
  it('credits the workspace exactly once and stores the answers', async () => {
    const account = await seedAccount();

    const outcome = await deliver(account);

    expect(outcome).toMatchObject({ status: 'granted', grantMicros: GRANT });
    expect(await balance()).toBe(GRANT);
    await assertBalanceMatchesLedger();

    const stored = await dataSource.getRepository(FeedbackSubmission).findOneByOrFail({ userId: account.userId });
    expect(stored.grantedUserId).toBe(account.userId);
    expect(stored.submissionId).toBe('submission-1');
    expect(JSON.stringify(stored.answers)).toContain('It was fast.');
  });

  it('never stores the token the submission carried', async () => {
    const account = await seedAccount();
    const token = issueFeedbackToken(config.auth.secret, {
      userId: account.userId,
      workspaceId: account.workspaceId,
      issuedAt: Date.now(),
    });
    await deliver(account, { token });

    // The hidden fields hold a credential; a credential in an analytics table is
    // a credential in every backup of that table.
    const stored = await dataSource.getRepository(FeedbackSubmission).findOneByOrFail({ userId: account.userId });
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('writes an ordinary ledger grant that names its origin and its campaign', async () => {
    const account = await seedAccount();

    await deliver(account);

    const entry = await dataSource
      .getRepository(CreditTransaction)
      .findOneByOrFail({ idempotencyKey: `feedback:${account.userId}` });
    expect(entry.kind).toBe('grant');
    expect(entry.amountMicros).toBe(GRANT);
    expect(entry.reference).toBe(FEEDBACK_GRANT_REFERENCE);
    expect(entry.description).toContain(FIRST_GRANT_CAMPAIGN);
  });

  it('reports it to analytics keyed on the ledger entry, so a redelivery cannot double-count', async () => {
    const account = await seedAccount();

    const outcome = await deliver(account);
    await deliver(account);

    expect(captured).toEqual([
      {
        uuid: (outcome as { creditTransactionId: string }).creditTransactionId,
        distinctId: account.userId,
        outcome: 'granted',
        grantMicros: GRANT,
      },
    ]);
  });

  it('still credits an account that topped up between opening the form and submitting it', async () => {
    const account = await seedAccount();
    const { body, signature } = submission(account);
    await dataSource.getRepository(Workspace).update({ id: account.workspaceId }, { balanceMicros: 90_000_000 });

    expect(await feedback.handleDelivery(body, signature)).toMatchObject({ status: 'granted' });
  });
});

describe('a submission that has not', () => {
  it('grants nothing when the provider signature is wrong', async () => {
    const account = await seedAccount();
    const { body, signature } = submission(account, { secret: 'not-our-secret' });

    await expect(feedback.handleDelivery(body, signature)).rejects.toBeInstanceOf(FeedbackSignatureError);
    expect(await balance()).toBe(0);
    expect(await dataSource.getRepository(FeedbackSubmission).count()).toBe(0);
  });

  it('grants nothing when the hidden token is missing, forged or expired', async () => {
    const account = await seedAccount();
    const stale = Date.now() - config.feedback.tokenTtl - 1;

    for (const token of [
      '',
      'forged.token',
      issueFeedbackToken('someone-elses-secret'.padEnd(48, 'z'), {
        userId: account.userId,
        workspaceId: account.workspaceId,
        issuedAt: Date.now(),
      }),
    ]) {
      await expect(deliver(account, { token })).rejects.toBeInstanceOf(FeedbackSignatureError);
    }
    await expect(deliver(account, { issuedAt: stale })).rejects.toBeInstanceOf(FeedbackSignatureError);

    expect(await balance()).toBe(0);
    expect(await dataSource.getRepository(FeedbackSubmission).count()).toBe(0);
    expect(captured).toEqual([]);
  });

  it('refuses a token whose workspace is not the one the account’s first grant landed in', async () => {
    const account = await seedAccount();
    const other = { userId: account.userId, workspaceId: randomUUID() };

    expect(await deliver(other)).toEqual({ status: 'refused', reason: 'unknown_account' });
    expect(await balance()).toBe(0);
    // Nothing is filed against an account the token invented.
    expect(await dataSource.getRepository(FeedbackSubmission).count()).toBe(0);
    expect(captured).toEqual([
      expect.objectContaining({ outcome: 'refused', reason: 'unknown_account', grantMicros: 0 }),
    ]);
  });

  it('refuses an account that is no longer eligible, and keeps its answers anyway', async () => {
    const account = await seedAccount({ tokens: 0 });

    expect(await deliver(account)).toEqual({ status: 'refused', reason: 'not_eligible' });
    expect(await balance()).toBe(0);

    const stored = await dataSource.getRepository(FeedbackSubmission).findOneByOrFail({ userId: account.userId });
    expect(stored.grantedUserId).toBeNull();
    expect(stored.refusalReason).toBe('not_eligible');
    expect(JSON.stringify(stored.answers)).toContain('It was fast.');
  });

  it('refuses a second submission from an account that already has its grant', async () => {
    const account = await seedAccount();
    await deliver(account);

    expect(await deliver(account, { submissionId: 'submission-2' })).toEqual({
      status: 'refused',
      reason: 'already_granted',
    });
    expect(await balance()).toBe(GRANT);
    await assertBalanceMatchesLedger();
  });
});

describe('redelivery', () => {
  it('settles a repeated delivery onto the row the first one wrote', async () => {
    const account = await seedAccount();
    await deliver(account);

    expect(await deliver(account)).toEqual({ status: 'replayed' });
    expect(await balance()).toBe(GRANT);
    expect(await dataSource.getRepository(CreditTransaction).count()).toBe(1);
    expect(await dataSource.getRepository(FeedbackSubmission).count()).toBe(1);
  });

  it('grants exactly once when two deliveries race for the same account', async () => {
    const account = await seedAccount();

    const outcomes = await Promise.all([
      deliver(account, { submissionId: 'submission-a' }),
      deliver(account, { submissionId: 'submission-b' }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'granted')).toHaveLength(1);
    expect(await balance()).toBe(GRANT);
    await assertBalanceMatchesLedger();
  });

  it('ignores an event that is not a submission at all', async () => {
    const body = Buffer.from(JSON.stringify({ event_type: 'form_ping' }), 'utf8');
    const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64')}`;

    expect(await feedback.handleDelivery(body, signature)).toEqual({ status: 'ignored' });
  });
});
