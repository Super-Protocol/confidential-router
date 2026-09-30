import { expect, type Page, test } from '@playwright/test';
import { mockClipboard, signIn } from './fixtures';

/**
 * What the chat screen does in a real browser on **this suite's origin**.
 *
 * That qualifier is the whole shape of this file. The suite serves the console
 * from `http://console.localtest.me:4300` — a named http origin, deliberately, so
 * that cookie behaviour matches production (`origins.ts`). A named http origin is
 * not a *secure context*, and browsers withhold `crypto.subtle` from those. So the
 * chat's tier-1 verifier genuinely cannot run here, and the interesting question
 * is not "does the happy path work" but "does the screen say the right thing when
 * it cannot verify" — which is the honesty property the whole feature turns on,
 * and which no other layer tests in a real browser.
 *
 * The happy path is covered where Web Crypto exists: the component tests run the
 * verifier against the cross-implementation conformance vectors
 * (`verification/evidence-gate.spec.ts`). Exercising it end to end needs an HTTPS
 * origin, which is a QA scenario on a real deployment rather than something this
 * suite can stand up.
 */

const MODEL_ID = 'meta/llama-3.3-70b-instruct:tdx';
const ENDPOINT_HOST = 'router.e2e.swarm.cloud';

function chatOperations(overrides: { chatSettings?: Record<string, unknown> } = {}) {
  return {
    ChatScreen: {
      chatSettings: {
        __typename: 'ChatSettings',
        enabled: true,
        maxMessageChars: 8_000,
        maxThreads: 50,
        maxMessagesPerThread: 200,
        historyStorage: 'ATTESTED_SERVER',
        chatModelIds: [MODEL_ID],
        ...overrides.chatSettings,
      },
      models: [
        {
          __typename: 'Model',
          id: MODEL_ID,
          name: 'Llama 3.3 70B Instruct',
          contextLength: 128_000,
          capabilities: ['CHAT', 'COMPLETIONS'],
          tee: 'Intel TDX + H100 CC',
          pricing: { __typename: 'Pricing', promptPer1m: '280000', completionPer1m: '420000' },
          endpoint: {
            __typename: 'Endpoint',
            id: 'ep-1',
            name: 'confidential-router',
            hostname: ENDPOINT_HOST,
            tee: 'Intel TDX + H100 CC',
            evidenceState: 'PUBLISHED',
            latestEvidence: null,
          },
        },
      ],
    },
  };
}

async function openChat(page: Page, baseURL: string, operations = chatOperations()): Promise<string[]> {
  const inference: string[] = [];
  // Any request to the gateway is a failure of the gate, so it is recorded
  // rather than answered.
  await page.route('**/v1/chat/completions', (route) => {
    inference.push(route.request().url());
    return route.fulfill({ status: 500, body: 'the composer should not have sent this' });
  });
  await mockClipboard(page);
  await signIn(page, baseURL, operations);
  await page.goto('/chat');
  return inference;
}

test.describe('Chat', () => {
  test('refuses to send, and blames its own origin, when the browser withholds Web Crypto', async ({
    page,
    baseURL,
  }) => {
    const inference = await openChat(page, baseURL as string);

    // Not "the evidence did not check out": the deployment's evidence was never
    // looked at. Saying which is the point — the message names the fix.
    const reason = page.getByText(/withholds the Web Crypto API/i);
    await expect(reason).toBeVisible();
    await expect(reason).toContainText('HTTPS');
    await expect(reason).toContainText('nothing will be sent');

    await expect(page.getByLabel('Message')).toBeDisabled();
    await expect(page.getByRole('button', { name: /send/i })).toBeDisabled();
    expect(inference).toEqual([]);
  });

  test('reports the same thing in the verification panel, per check', async ({ page, baseURL }) => {
    await openChat(page, baseURL as string);

    await page.getByRole('button', { name: /what has been verified/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Web Crypto available in this page')).toBeVisible();
    // Tier 3 is still offered, because Gatekeeper does not need this page to work.
    await expect(dialog.getByText('Verify it yourself')).toBeVisible();
    await expect(dialog.getByText(`gatekeeper endpoint add router --upstream https://${ENDPOINT_HOST}`)).toBeVisible();
  });

  test('names the storage boundary and the maintenance risk in the same sentence', async ({ page, baseURL }) => {
    await openChat(page, baseURL as string);

    // Rendered, not just present in a constant: the caveat has to survive into
    // the markup a reader actually sees, beside the boundary claim rather than
    // somewhere further down the page.
    const note = page.getByText(/stored inside the attested boundary/i);
    await expect(note).toBeVisible();
    await expect(note).toContainText('may be lost during maintenance');
  });

  test('says so, rather than showing a dead composer, when the chat is switched off', async ({ page, baseURL }) => {
    await openChat(page, baseURL as string, chatOperations({ chatSettings: { enabled: false } }));

    await expect(page.getByText(/switched off on this deployment/i)).toBeVisible();
    await expect(page.getByLabel('Message')).toHaveCount(0);
  });
});
