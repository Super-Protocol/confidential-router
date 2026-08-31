import type { MockLink } from '@apollo/client/testing';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithSession, sessionMock } from '../../test-utils';
import { APIKeysScreen } from './api-keys-screen';
import { API_KEYS_QUERY, CREATE_API_KEY, REVOKE_API_KEY, UPDATE_API_KEY } from './operations';
import type { ApiKeyRow } from './types';

// `SessionProvider` redirects on an expired session; nothing here exercises that.
vi.mock('next/navigation', () => ({
  usePathname: () => '/keys',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

const WORKSPACE_ID = 'ws-1';

/**
 * Apollo's cache adds `__typename` to every selection set, so a mock without it
 * writes a row the cache then reads back incomplete.
 */
type MockedApiKey = ApiKeyRow & { __typename: 'ApiKey' };

const LIVE_KEY: MockedApiKey = {
  __typename: 'ApiKey',
  id: 'key-1',
  name: 'production-agent',
  prefix: 'sk-tee-v1-4f',
  modelScope: ['meta/llama-3.3-70b-instruct:tdx'],
  createdAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-12-31T23:59:59.999Z',
  lastUsedAt: '2026-08-30T12:00:00.000Z',
  revokedAt: null,
  spendLimitMicros: '50000000',
  spentTotalMicros: '12500000',
  requestsPerMinute: 60,
  tokensPerMinute: null,
};

const REVOKED_KEY: MockedApiKey = {
  ...LIVE_KEY,
  id: 'key-2',
  name: 'old-laptop',
  prefix: 'sk-tee-v1-91',
  modelScope: null,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: '2026-08-20T00:00:00.000Z',
  spendLimitMicros: null,
  spentTotalMicros: '0',
  requestsPerMinute: null,
};

const MODELS = [
  { __typename: 'Model', id: 'meta/llama-3.3-70b-instruct:tdx', name: 'Llama 3.3 70B Instruct' },
  { __typename: 'Model', id: 'gpt-oss-120b:tdx', name: 'GPT-OSS 120B' },
];

function keysMock(keys: MockedApiKey[] = [LIVE_KEY, REVOKED_KEY]): MockLink.MockedResponse {
  return {
    request: { query: API_KEYS_QUERY, variables: { workspaceId: WORKSPACE_ID } },
    result: { data: { apiKeys: keys, models: MODELS } },
    // `cache-and-network` plus the post-create refetch ask more than once.
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

function renderScreen(mocks: MockLink.MockedResponse[] = [keysMock()]) {
  return renderWithSession(<APIKeysScreen />, { mocks: [sessionMock(), ...mocks] });
}

/**
 * The "New key" button is disabled until the session names a workspace, and the
 * scope picker is empty until the catalogue lands — so every interaction test
 * waits for the loaded table first.
 */
async function openCreateDialog() {
  await screen.findByText('production-agent');
  await userEvent.click(screen.getByRole('button', { name: 'New key' }));
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('APIKeysScreen', () => {
  it('lists every key with its masked value, scope, usage and limit', async () => {
    renderScreen();

    const row = (await screen.findByText('production-agent')).closest('tr') as HTMLElement;
    expect(within(row).getByText('sk-tee-v1-4f…')).toBeInTheDocument();
    expect(within(row).getByText('Llama 3.3 70B Instruct')).toBeInTheDocument();
    expect(within(row).getByText('$12.50')).toBeInTheDocument();
    expect(within(row).getByText('$50.00')).toBeInTheDocument();
    // 12.5 of 50 dollars spent.
    expect(within(row).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  });

  it('marks a revoked key and offers no actions on it', async () => {
    renderScreen();

    const row = (await screen.findByText('old-laptop')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Revoked')).toBeInTheDocument();
    expect(within(row).getByText('All models')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  it('invites the first key when the workspace has none', async () => {
    renderScreen([keysMock([])]);

    expect(await screen.findByText('No keys yet')).toBeInTheDocument();
  });

  it('reports a failed load instead of an empty table', async () => {
    renderScreen([
      {
        request: { query: API_KEYS_QUERY, variables: { workspaceId: WORKSPACE_ID } },
        error: new Error('network down'),
      },
    ]);

    expect(await screen.findByText('The keys could not be loaded')).toBeInTheDocument();
  });

  it('shows the drop-in snippet with the newest live key prefix, never a whole key', async () => {
    renderScreen();

    await screen.findByText('production-agent');

    const snippet = screen.getByTestId('wiring-snippet-curl');
    expect(snippet).toHaveTextContent('sk-tee-v1-4f…');
    expect(snippet).toHaveTextContent('http://127.0.0.1:8787/v1');
  });

  describe('the create flow', () => {
    const created: MockedApiKey = { ...LIVE_KEY, id: 'key-3', name: 'ci-agent', prefix: 'sk-tee-v1-aa' };
    const SECRET = 'sk-tee-v1-aabbccddeeff00112233445566778899';

    function createMock(): MockLink.MockedResponse {
      return {
        request: {
          query: CREATE_API_KEY,
          variables: {
            input: {
              workspaceId: WORKSPACE_ID,
              name: 'ci-agent',
              modelIds: ['gpt-oss-120b:tdx'],
              spendLimitMicros: '25000000',
              expiresAt: null,
              requestsPerMinute: null,
              tokensPerMinute: null,
            },
          },
        },
        result: { data: { createApiKey: { secret: SECRET, key: created } } },
      };
    }

    it('scopes and caps the key, then shows the secret exactly once with a filled-in snippet', async () => {
      renderScreen([keysMock(), createMock()]);

      await openCreateDialog();
      await userEvent.type(screen.getByLabelText('Name'), 'ci-agent');
      await userEvent.click(screen.getByRole('checkbox', { name: /Restrict this key to specific models/ }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'GPT-OSS 120B' }));
      await userEvent.type(screen.getByLabelText('Spend limit (USD)'), '25');
      await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

      expect(await screen.findByText('Copy your key now')).toBeInTheDocument();
      expect(screen.getByTestId('created-key-secret')).toHaveTextContent(SECRET);

      const snippet = within(screen.getByRole('dialog')).getByTestId('wiring-snippet-curl');
      expect(snippet).toHaveTextContent(SECRET);
    });

    it('copies the whole key, not the prefix', async () => {
      renderScreen([keysMock(), createMock()]);

      await openCreateDialog();
      await userEvent.type(screen.getByLabelText('Name'), 'ci-agent');
      await userEvent.click(screen.getByRole('checkbox', { name: /Restrict this key to specific models/ }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'GPT-OSS 120B' }));
      await userEvent.type(screen.getByLabelText('Spend limit (USD)'), '25');
      await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

      await userEvent.click(await screen.findByRole('button', { name: 'Copy the API key' }));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SECRET);
    });

    it('refuses to submit a nameless key and never calls the API', async () => {
      renderScreen();

      await openCreateDialog();
      await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

      expect(await screen.findByText(/Give the key a name/)).toBeInTheDocument();
      expect(screen.queryByText('Copy your key now')).not.toBeInTheDocument();
    });

    it('surfaces what the API refused', async () => {
      renderScreen([
        keysMock(),
        {
          request: {
            query: CREATE_API_KEY,
            variables: {
              input: {
                workspaceId: WORKSPACE_ID,
                name: 'ci-agent',
                modelIds: null,
                spendLimitMicros: null,
                expiresAt: null,
                requestsPerMinute: null,
                tokensPerMinute: null,
              },
            },
          },
          result: { errors: [{ message: 'A key named ci-agent already exists.' }] },
        },
      ]);

      await openCreateDialog();
      await userEvent.type(screen.getByLabelText('Name'), 'ci-agent');
      await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('A key named ci-agent already exists.');
    });
  });

  it('edits the limits of one key', async () => {
    renderScreen([
      keysMock(),
      {
        request: {
          query: UPDATE_API_KEY,
          variables: {
            id: 'key-1',
            input: {
              name: 'production-agent',
              modelIds: ['meta/llama-3.3-70b-instruct:tdx'],
              spendLimitMicros: '75000000',
              expiresAt: '2026-12-31T23:59:59.999Z',
              requestsPerMinute: 60,
              tokensPerMinute: null,
            },
          },
        },
        result: { data: { updateApiKey: { ...LIVE_KEY, spendLimitMicros: '75000000' } } },
      },
    ]);

    await userEvent.click(await screen.findByRole('button', { name: 'Actions for production-agent' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit limits and scope' }));
    await userEvent.clear(screen.getByLabelText('Spend limit (USD)'));
    await userEvent.type(screen.getByLabelText('Spend limit (USD)'), '75');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('$75.00')).toBeInTheDocument();
  });

  it('asks before revoking, and says the key stops working', async () => {
    renderScreen([
      keysMock(),
      {
        request: { query: REVOKE_API_KEY, variables: { id: 'key-1' } },
        result: { data: { revokeApiKey: { ...LIVE_KEY, revokedAt: '2026-08-31T00:00:00.000Z' } } },
      },
    ]);

    await userEvent.click(await screen.findByRole('button', { name: 'Actions for production-agent' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Revoke' }));
    expect(screen.getByText(/The next request made with this key is refused/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Revoke key' }));

    const row = (await screen.findByText('production-agent')).closest('tr') as HTMLElement;
    expect(await within(row).findByText('Revoked')).toBeInTheDocument();
  });
});
