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

const THREAD_ID = 'thread-1';
const THREAD_TITLE = 'What runs inside the enclave?';

/**
 * One stored conversation, for the cases that need a row on screen — the storage
 * note's delete hand-off is a claim about a control that has to exist.
 */
function storedThread() {
  const thread = {
    __typename: 'ChatThread',
    id: THREAD_ID,
    title: THREAD_TITLE,
    modelId: MODEL_ID,
    updatedAt: '2026-10-01T10:00:00.000Z',
  };
  return {
    ChatThreads: { chatThreads: [thread] },
    ChatThread: {
      chatThread: {
        ...thread,
        messages: [
          {
            __typename: 'ChatMessage',
            id: 'm1',
            role: 'USER',
            content: THREAD_TITLE,
            error: null,
            createdAt: '2026-10-01T10:00:00.000Z',
          },
        ],
      },
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

  test('shows the storage boundary inline and the caveat in the popover behind it', async ({ page, baseURL }) => {
    await openChat(page, baseURL as string);

    // Rendered, not just present in a constant: both halves have to survive into
    // the markup a reader sees — the claim where they cannot miss it, the caveat
    // where they went looking for it, and never the other way round (SUP-189).
    await expect(page.getByText('Stored inside the attested boundary')).toBeVisible();
    await expect(page.getByText(/may be lost/i)).toHaveCount(0);

    await page.getByRole('button', { name: /what this means for your conversations/i }).click();

    const note = page.getByRole('dialog');
    await expect(note.getByText(/encrypted at rest/i)).toBeVisible();
    await expect(note.getByText('Your conversations may be lost during infrastructure maintenance.')).toBeVisible();
  });

  test('hands the reader the delete control, and closes behind itself', async ({ page, baseURL }) => {
    /*
     * The half of the hand-off that only a real browser can answer. Two things
     * have to hold and neither is visible to jsdom: Radix dismisses the popover
     * when focus leaves its layer, and the bin — `opacity-0` until its row is
     * hovered or focused — actually becomes visible once focus lands there. A
     * link that left the popover covering the control, or revealed nothing,
     * would pass every unit test in the repository.
     */
    await openChat(page, baseURL as string, { ...chatOperations(), ...storedThread() });

    await page.getByRole('button', { name: /what this means for your conversations/i }).click();
    await page.getByRole('button', { name: 'Show the delete control' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: THREAD_TITLE, exact: true })).toBeFocused();
    // `toBeVisible` would pass at `opacity: 0` — Playwright counts a transparent
    // element as visible — so the reveal is asserted on the computed value.
    await expect(page.getByRole('button', { name: `Delete “${THREAD_TITLE}”` })).toHaveCSS('opacity', '1');
  });

  test('offers “Inspect attestation”, and draws no graph from evidence that did not check out', async ({
    page,
    baseURL,
  }) => {
    /*
     * The degraded path, which is the only one this origin can reach — and the
     * one worth having in a real browser: a panel that rendered an empty canvas
     * here would read as "this deployment runs nothing", which is a far more
     * convincing wrong answer than a stated failure.
     *
     * The populated panel is audited at `/dev/attestation`, where the same
     * component is handed a verified result without a verifier; see
     * `accessibility.spec.ts`.
     */
    await openChat(page, baseURL as string);

    await page.getByRole('button', { name: 'Inspect attestation' }).click();

    const dialog = page.getByRole('dialog', { name: /Attestation for this endpoint/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Nothing below is drawn from this endpoint/)).toBeVisible();
    await expect(dialog.getByText(/withholds the Web Crypto API/i)).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Deployment graph' })).toHaveCount(0);
  });

  test('says so, rather than showing a dead composer, when the chat is switched off', async ({ page, baseURL }) => {
    await openChat(page, baseURL as string, chatOperations({ chatSettings: { enabled: false } }));

    await expect(page.getByText(/switched off on this deployment/i)).toBeVisible();
    await expect(page.getByLabel('Message')).toHaveCount(0);
  });
});
