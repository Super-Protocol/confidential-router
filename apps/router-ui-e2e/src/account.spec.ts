import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './fixtures';

/** Same bar as `accessibility.spec.ts`: nothing serious or critical. */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

  return results.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(' ')) }));
}

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000a1';

type Responder = Record<string, unknown> | ((variables: Record<string, unknown>) => Record<string, unknown>);

/**
 * Answers the account screens' operations from fixtures.
 *
 * Registered *after* `signIn`, whose handler answers only `Session`: Playwright
 * resolves routes last-registered-first, so this one sees the request and falls
 * through to the session fixture for anything it does not know.
 */
async function mockConsole(page: Page, data: Record<string, Responder>): Promise<void> {
  await page.route('**/graphql', async (route) => {
    const body = route.request().postDataJSON() as { operationName?: string; variables?: Record<string, unknown> };
    const handler = data[body?.operationName ?? ''];

    if (handler === undefined) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: typeof handler === 'function' ? handler(body.variables ?? {}) : handler }),
    });
  });
}

function balance(autoTopUp: Record<string, unknown>) {
  return {
    __typename: 'CreditBalance',
    workspaceId: WORKSPACE_ID,
    balanceMicros: '170650000',
    spendable: true,
    minTopUpMicros: '5000000',
    autoTopUp: {
      __typename: 'AutoTopUp',
      enabled: false,
      available: true,
      thresholdMicros: null,
      amountMicros: null,
      lastChargedAt: null,
      ...autoTopUp,
    },
  };
}

const LEDGER = {
  __typename: 'CreditTransactionConnection',
  totalCount: 1,
  pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: 'txn-1' },
  edges: [
    {
      __typename: 'CreditTransactionEdge',
      cursor: 'txn-1',
      node: {
        __typename: 'CreditTransaction',
        id: 'txn-1',
        createdAt: '2026-08-30T12:00:00.000Z',
        kind: 'PURCHASE',
        amountMicros: '25000000',
        reference: 'pi_123',
        description: 'Credit purchase of $25.00',
      },
    },
  ],
};

test.describe('Credits', () => {
  /**
   * The acceptance criterion: change the automatic top-up threshold, and see
   * the value the server stored — not the one that was typed. The stub only
   * answers with what the mutation was sent, so a screen that rendered its own
   * form state would pass this test with the write dropped.
   */
  test('updates the auto top-up threshold and shows it persisted', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);

    let stored: Record<string, unknown> = { enabled: false, thresholdMicros: null, amountMicros: null };
    let sentSettings: Record<string, unknown> | null = null;

    await mockConsole(page, {
      Credits: () => ({ creditBalance: balance(stored), creditTransactions: LEDGER }),
      SetAutoTopUp: (variables) => {
        const input = (variables.input ?? {}) as { settings: Record<string, unknown> };
        sentSettings = input.settings;
        stored = { ...input.settings, lastChargedAt: null };
        return { setAutoTopUp: balance(stored) };
      },
    });

    await page.goto('/credits');
    await expect(page.getByTestId('credit-balance')).toHaveText('$170.65');

    await page.getByLabel('Enable automatic top-up').click();
    await page.getByLabel('When balance falls below (USD)').fill('20');
    await page.getByLabel('Buy this much (USD)').fill('25');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('Automatic top-up updated.')).toBeVisible();
    // Micro-USD on the wire, dollars in the field.
    expect(sentSettings).toEqual({ enabled: true, thresholdMicros: '20000000', amountMicros: '25000000' });

    // A reload reads the value back from the (stubbed) server, not from the form.
    await page.reload();
    await expect(page.getByLabel('Enable automatic top-up')).toBeChecked();
    await expect(page.getByLabel('When balance falls below (USD)')).toHaveValue('20');
    await expect(page.getByLabel('Buy this much (USD)')).toHaveValue('25');
  });

  test('sends the browser to Stripe Checkout for a manual top-up', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);
    await mockConsole(page, {
      Credits: () => ({
        creditBalance: balance({}),
        creditTransactions: LEDGER,
      }),
      CreateCheckout: () => ({
        createCheckout: {
          __typename: 'CheckoutSession',
          // Not a real Stripe URL: the test asserts the redirect, and following
          // one to stripe.com from CI would be a network call, not a test.
          url: 'http://127.0.0.1:4300/credits?topup=success',
          ref: 'cs_test_1',
        },
      }),
    });

    await page.goto('/credits');
    await page.getByRole('button', { name: '$50' }).click();
    await page.getByRole('button', { name: 'Add credits' }).click();

    await expect(page.getByText('Payment received.')).toBeVisible();
    // The parameter is cleared, so a reload does not repeat the confirmation.
    await expect(page).toHaveURL(/\/credits$/);
  });

  test('has no serious axe violations', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);
    await mockConsole(page, { Credits: () => ({ creditBalance: balance({}), creditTransactions: LEDGER }) });

    await page.goto('/credits');
    await expect(page.getByTestId('credit-balance')).toHaveText('$170.65');
    await expect(page.getByRole('cell', { name: 'Credit purchase of $25.00' })).toBeVisible();

    expect(await seriousViolations(page)).toEqual([]);
  });
});

test.describe('Preferences', () => {
  const PREFERENCES = {
    __typename: 'UserPreferences',
    archiveEvidence: true,
    evidenceRetentionDays: 90,
    notifyOnMeasurementChange: true,
    desktopNotifications: false,
    emailReceipts: true,
  };

  function preferencesResponder(stored: () => Record<string, unknown>) {
    return () => ({
      me: {
        __typename: 'User',
        id: '00000000-0000-4000-8000-000000000001',
        email: 'developer@example.com',
        createdAt: '2026-04-02T08:00:00.000Z',
        preferences: stored(),
      },
    });
  }

  /**
   * The other acceptance criterion: exporting the bundle downloads a zip.
   *
   * `exportEvidence` only mints a link — the archive is built by router-api when
   * the link is followed — so the test stubs both halves: the mutation, and the
   * REST endpoint the browser then navigates to.
   */
  test('exports the evidence bundle as a zip download', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);

    const stored: Record<string, unknown> = { ...PREFERENCES };
    let requestedRange: { from?: unknown; to?: unknown } = {};

    await mockConsole(page, {
      Preferences: preferencesResponder(() => stored),
      ExportEvidence: (variables) => {
        requestedRange = { from: variables.from, to: variables.to };
        return {
          exportEvidence: {
            __typename: 'EvidenceExport',
            url: 'http://127.0.0.1:4300/exports/evidence.zip?token=e2e',
            expiresAt: '2026-08-31T10:15:00.000Z',
          },
        };
      },
    });

    await page.route('**/exports/evidence.zip*', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="evidence-${WORKSPACE_ID}.zip"`,
        },
        // The four bytes of an empty zip's end-of-central-directory signature.
        body: Buffer.from('504b0506000000000000000000000000000000000000', 'hex'),
      });
    });

    await page.goto('/preferences');
    await expect(page.getByRole('switch', { name: 'Archive quotes' })).toBeChecked();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download' }).click(),
    ]);

    // router-api names the file; the console must not override it with one
    // derived from a URL that carries the signing token.
    expect(download.suggestedFilename()).toBe(`evidence-${WORKSPACE_ID}.zip`);
    // The two date fields become a half-open range of whole UTC days.
    expect(String(requestedRange.from)).toMatch(/T00:00:00\.000Z$/);
    expect(String(requestedRange.to)).toMatch(/T00:00:00\.000Z$/);
    expect(Date.parse(String(requestedRange.to))).toBeGreaterThan(Date.parse(String(requestedRange.from)));
  });

  test('saves a toggle the moment it is flipped', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);

    let stored: Record<string, unknown> = { ...PREFERENCES };
    await mockConsole(page, {
      Preferences: preferencesResponder(() => stored),
      UpdatePreferences: (variables) => {
        stored = { ...stored, ...((variables.input ?? {}) as Record<string, unknown>) };
        return { updatePreferences: stored };
      },
    });

    await page.goto('/preferences');
    await page.getByRole('switch', { name: 'Desktop notifications' }).click();
    await expect(page.getByText('Desktop notifications on.')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('switch', { name: 'Desktop notifications' })).toBeChecked();
  });

  test('has no serious axe violations', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);
    await mockConsole(page, { Preferences: preferencesResponder(() => PREFERENCES) });

    await page.goto('/preferences');
    await expect(page.getByRole('switch', { name: 'Archive quotes' })).toBeVisible();

    expect(await seriousViolations(page)).toEqual([]);
  });
});

test.describe('Profile', () => {
  const PROFILE = {
    me: {
      __typename: 'User',
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Dev Eloper',
      email: 'developer@example.com',
      avatarUrl: null,
      createdAt: '2026-04-02T08:00:00.000Z',
    },
    activitySeries: Array.from({ length: 7 }, (_, index) => ({
      __typename: 'ActivityPoint',
      bucket: new Date(Date.now() - (6 - index) * 86_400_000).toISOString(),
      spendMicros: String((index + 1) * 1_000_000),
      requests: index + 1,
      promptTokens: 1000,
      completionTokens: 500,
    })),
    usageByModel: [
      {
        __typename: 'ModelUsage',
        modelId: 'meta/llama-3.3-70b-instruct:tdx',
        name: 'Llama 3.3 70B Instruct',
        spendMicros: '21000000',
        requests: 21,
      },
    ],
    signedResponseDays: [new Date().toISOString()],
  };

  test('shows the account, its week of spend and the evidence heatmap', async ({ page, baseURL }) => {
    await signIn(page, baseURL as string);
    await mockConsole(page, { Profile: () => PROFILE });

    await page.goto('/profile');

    await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
    await expect(page.getByText('Llama 3.3 70B Instruct')).toBeVisible();
    await expect(page.getByRole('img', { name: /Days with published evidence/ })).toBeVisible();

    expect(await seriousViolations(page)).toEqual([]);
  });
});
