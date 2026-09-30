import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishedEndpoint } from '../../test-fixtures';
import { renderWithSession, TEST_WORKSPACES } from '../../test-utils';
import { typedSessionMock } from '../typed-session';
import { ChatScreen } from './chat-screen';
import { CHAT_CREDENTIAL, CHAT_SCREEN_QUERY } from './operations';

/**
 * The two browser-side verification tiers are unit-tested against the
 * conformance vectors in `verification/*.spec.ts`. Here they are stubbed, because
 * what this suite is about is the screen's *contract with them*: nothing may be
 * sent until tier 1 has passed, a refusal has to be visible where the send button
 * is, and the transcript has to stay in this browser.
 */
// `SessionProvider` calls `useRouter`, which throws outside an app-router tree.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const gate = vi.hoisted(() => ({ result: null as unknown }));
const bridge = vi.hoisted(() => ({ outcome: { status: 'absent' } as unknown }));

vi.mock('./verification/evidence-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./verification/evidence-gate')>()),
  runEvidenceGate: vi.fn(async () => gate.result),
}));

vi.mock('./verification/extension-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./verification/extension-bridge')>()),
  requestExtensionVerification: vi.fn(async () => bridge.outcome),
}));

const WORKSPACE_ID = TEST_WORKSPACES[0].id;

const PASSING_GATE = {
  unlocked: true,
  checks: [
    { id: 'bundle', status: 'pass', detail: 'The host served a swarm-evidence v1 bundle.' },
    { id: 'chain', status: 'pass', detail: 'Each certificate signs the next.' },
    { id: 'signature', status: 'pass', detail: 'The evidence is signed by the chain leaf.' },
    { id: 'freshness', status: 'pass', detail: 'Signed 2 minutes ago.' },
    { id: 'binding', status: 'pass', detail: 'The published TLS certificate matches.' },
    { id: 'root', status: 'unavailable', detail: 'The platform publishes no TEE quote for this hostname yet.' },
  ],
  registry: null,
  evidence: {
    hostname: 'llama-33-70b.tee.swarm.cloud',
    source: 'endpoint',
    issuedAt: '2026-09-30T11:58:00.000Z',
    evidenceDigest: 'sha256/9Xk2fT1pQvA7BdE4rL0eQm3XkTpZ8vNc1YsWuHgJoAs',
    certFingerprint: 'sha256/PmQ7dR2xWvB9CkE5sM1fTnZ4aYh6UbLp0GjXoIeVwNs',
    rootSubject: 'CN=Super Swarm Root CA',
    rootFingerprint: 'sha256/eN7J30KqI96yWxc5VLOpL5VPQYyBKAA2K3HhPBIBXgg',
    quoteFormat: null,
    measurement: null,
  },
};

const FAILING_GATE = {
  unlocked: false,
  checks: [{ id: 'signature', status: 'fail', detail: 'The signature did not verify.' }],
  registry: null,
  evidence: null,
};

function settings(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'ChatSettings' as const,
    enabled: true,
    maxMessageChars: 8_000,
    maxThreads: 50,
    maxMessagesPerThread: 200,
    historyStorage: 'BROWSER_LOCAL' as const,
    chatModelIds: ['meta/llama-3.3-70b-instruct:tdx'],
    ...overrides,
  };
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'Model' as const,
    id: 'meta/llama-3.3-70b-instruct:tdx',
    name: 'Llama 3.3 70B Instruct',
    contextLength: 131_072,
    capabilities: ['CHAT' as const, 'COMPLETIONS' as const],
    tee: 'Intel TDX + H100 CC',
    pricing: { __typename: 'Pricing' as const, promptPer1m: '350000', completionPer1m: '900000' },
    endpoint: publishedEndpoint(),
    ...overrides,
  };
}

function screenMock(overrides: Record<string, unknown> = {}): MockLink.MockedResponse {
  return {
    request: { query: CHAT_SCREEN_QUERY },
    result: { data: { chatSettings: settings(), models: [model()], ...overrides } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function credentialMock(): MockLink.MockedResponse {
  return {
    request: { query: CHAT_CREDENTIAL, variables: { input: { workspaceId: WORKSPACE_ID } } },
    result: {
      data: {
        chatCredential: {
          __typename: 'ChatCredential' as const,
          apiKeyId: 'key-1',
          secret: 'sk-tee-v1-chat-secret',
          expiresAt: '2099-01-01T00:00:00.000Z',
          baseUrl: 'https://api.router.test/v1',
          modelScope: ['meta/llama-3.3-70b-instruct:tdx'],
        },
      },
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function render(mocks: MockLink.MockedResponse[] = [screenMock()]) {
  return renderWithSession(<ChatScreen />, { mocks: [typedSessionMock(), ...mocks] });
}

/** A `fetch` that streams one answer back as Server-Sent Events. */
function streamingFetch(answer: string) {
  return vi.fn(async () => {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  gate.result = PASSING_GATE;
  bridge.outcome = { status: 'absent' };
});

describe('the evidence gate', () => {
  it('keeps the composer locked and says why until the endpoint verifies', async () => {
    // A composer that accepted keystrokes before verification would make the gate
    // decorative. It has to be visibly shut at the moment a user would press send.
    gate.result = FAILING_GATE;
    render();

    const message = await screen.findByLabelText('Message');
    await waitFor(() => expect(message).toBeDisabled());
    expect(screen.getByText(/did not check out, so nothing will be sent/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('labels a pass as this page’s own, self-reported check', async () => {
    render();

    expect(await screen.findByText('Verified by this page')).toBeInTheDocument();
    expect(screen.getByText(/self-reported/i)).toBeInTheDocument();
  });

  it('upgrades the badge when the extension verifies independently', async () => {
    bridge.outcome = { status: 'verified', verdict: { ok: true, rootName: 'Super Swarm Root CA' } };
    render();

    expect(await screen.findByText('Independently verified by the extension')).toBeInTheDocument();
  });

  it('shows every check, and the gatekeeper commands for this endpoint, in the panel', async () => {
    render();
    await screen.findByText('Verified by this page');

    await userEvent.click(screen.getByRole('button', { name: /what has been verified/i }));

    expect(await screen.findByText('Evidence signature')).toBeInTheDocument();
    expect(screen.getByText('Root vouched for by Super Protocol')).toBeInTheDocument();
    // Tier 3 hands over commands that need no editing: the hostname just verified
    // and the digest this router holds.
    expect(
      screen.getByText(
        `gatekeeper endpoint trust add router sha256:f579367d3d6942f03b05d138acbd1e426dd7913a59f2f35cd58b16b87809a00b`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/gatekeeper endpoint add router --upstream https:\/\/llama-33-70b/)).toBeInTheDocument();
  });
});

describe('sending a message', () => {
  it('calls /v1/chat/completions with the minted key and streams the answer in', async () => {
    const fetcher = streamingFetch('A TEE is a hardware-isolated environment.');
    vi.stubGlobal('fetch', fetcher);
    render([screenMock(), credentialMock()]);

    const message = await screen.findByLabelText('Message');
    await waitFor(() => expect(message).toBeEnabled());
    await userEvent.type(message, 'What is a TEE?');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('A TEE is a hardware-isolated environment.')).toBeInTheDocument();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.router.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-tee-v1-chat-secret');
    vi.unstubAllGlobals();
  });

  it('titles the thread from the question and keeps it in this browser', async () => {
    vi.stubGlobal('fetch', streamingFetch('Because it is.'));
    render([screenMock(), credentialMock()]);

    const message = await screen.findByLabelText('Message');
    await waitFor(() => expect(message).toBeEnabled());
    await userEvent.type(message, 'Why confidential computing?');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await screen.findByText('Because it is.');
    const conversations = screen.getByRole('list', { name: 'Conversations' });
    expect(conversations).toHaveTextContent('Why confidential computing?');
    expect(localStorage.getItem(`router-console.chat.v1.${WORKSPACE_ID}`)).toContain('Why confidential computing?');
    vi.unstubAllGlobals();
  });

  it('shows the gateway’s refusal on the turn it refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Not enough credits.', code: 'insufficient_credits' } }), {
            status: 402,
          }),
      ),
    );
    render([screenMock(), credentialMock()]);

    const message = await screen.findByLabelText('Message');
    await waitFor(() => expect(message).toBeEnabled());
    await userEvent.type(message, 'hello');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough credits.');
    vi.unstubAllGlobals();
  });
});

describe('the conversation list', () => {
  it('deletes a thread outright, leaving nothing in storage', async () => {
    vi.stubGlobal('fetch', streamingFetch('answer'));
    render([screenMock(), credentialMock()]);

    const message = await screen.findByLabelText('Message');
    await waitFor(() => expect(message).toBeEnabled());
    await userEvent.type(message, 'a question worth deleting');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByText('answer');

    await userEvent.click(
      screen.getByRole('button', { name: /delete “a question worth deleting” from this browser/i }),
    );

    await waitFor(() =>
      expect(localStorage.getItem(`router-console.chat.v1.${WORKSPACE_ID}`)).not.toContain('a question worth deleting'),
    );
    vi.unstubAllGlobals();
  });
});

describe('what the screen says about storage', () => {
  it('says the conversation is in this browser, and claims nothing more', async () => {
    render();

    expect(await screen.findByText(/This conversation is stored in this browser only\./)).toBeInTheDocument();
    expect(screen.queryByText(/attested boundary/i)).not.toBeInTheDocument();
  });
});

describe('a deployment without the chat', () => {
  it('says so, and points at the API instead of showing a dead composer', async () => {
    render([screenMock({ chatSettings: settings({ enabled: false }) })]);

    expect(await screen.findByText(/switched off on this deployment/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
  });

  it('says so when the catalogue has nothing that can chat', async () => {
    render([screenMock({ chatSettings: settings({ chatModelIds: [] }) })]);

    expect(await screen.findByText(/No chat-capable model is served/i)).toBeInTheDocument();
  });
});
