import type { MockLink } from '@apollo/client/testing';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { isAdminMock, renderWithSession, sessionMock } from '../../test-utils';
import { ALL_ENDPOINTS, DENIED_ENDPOINT, endpointsMock, PENDING_ENDPOINT, VERIFIED_ENDPOINT } from './admin-mocks';
import { ExternalEndpointsScreen, sortEndpoints } from './external-endpoints-screen';
import { REGISTER_EXTERNAL_ENDPOINT, ROTATE_EXTERNAL_ENDPOINT_KEY, SET_EXTERNAL_ENDPOINT_ENABLED } from './operations';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/endpoints',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * The register form has ten fields to fill through `userEvent`, and three of
 * these tests await a mutation that awaits its own refetch. Raised only because
 * a loaded CI box is slower than the one-second default assumes; nothing here
 * depends on the extra time to pass.
 */
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

function renderScreen({
  admin = true,
  mocks = [endpointsMock()],
}: {
  admin?: boolean;
  mocks?: MockLink.MockedResponse[];
} = {}) {
  return renderWithSession(<ExternalEndpointsScreen />, {
    mocks: [sessionMock(), isAdminMock(admin), ...mocks],
  });
}

/**
 * The drawer is a Radix sheet in a portal, and the screen paints twice — once
 * when the endpoints land and again when the admin flag does — so the dialog is
 * awaited rather than read on the tick after the click.
 */
async function openDrawer(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^Open ${name}:`) }));
  return screen.findByRole('dialog');
}

describe('ExternalEndpointsScreen', () => {
  it('lists every endpoint with the chip its status earns', async () => {
    renderScreen();

    expect(await screen.findByText('qwen3-coder')).toBeInTheDocument();

    // The vocabulary is a contract, not a style choice (ADR-008 §1): a chip that
    // said "Verified" alone would not say who verified.
    expect(screen.getByText('Verified by this router')).toBeInTheDocument();
    expect(screen.getByText('Denied by this router')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('shows the refusal reason beside a denied endpoint, not only in the drawer', async () => {
    renderScreen();

    expect(await screen.findByText('measurement not on the trust list')).toBeInTheDocument();
  });

  it('puts the endpoints that need attention first', () => {
    const sorted = sortEndpoints(ALL_ENDPOINTS);

    expect(sorted.map((endpoint) => endpoint.status)).toEqual([
      'DENIED_BY_THIS_ROUTER',
      'PENDING',
      'VERIFIED_BY_THIS_ROUTER',
      'DISABLED',
    ]);
  });

  it('explains the fail-closed default when nothing is registered', async () => {
    renderScreen({ mocks: [endpointsMock([])] });

    expect(await screen.findByText('No external endpoints')).toBeInTheDocument();
  });

  describe('admin gating', () => {
    it('offers registration, enable/disable and key rotation to an administrator', async () => {
      renderScreen({ admin: true });

      // The per-row actions need both the rows and the admin flag.
      await screen.findByText('qwen3-coder');
      expect(await screen.findByRole('button', { name: 'Add external endpoint' })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Rotate key' })).not.toHaveLength(0);
      expect(screen.getAllByRole('button', { name: 'Disable' })).not.toHaveLength(0);
      expect(screen.queryByTestId('admin-read-only-notice')).not.toBeInTheDocument();
    });

    /**
     * Ruling 3 / ADR-008 §7: a member sees everything that decides what the
     * router will proxy, and can change none of it. The mutations are not merely
     * disabled — they are absent, so a refusal is never provoked.
     */
    it('gives a signed-in member the facts and no controls', async () => {
      renderScreen({ admin: false });

      expect(await screen.findByText('qwen3-coder')).toBeInTheDocument();
      expect(screen.getByTestId('admin-read-only-notice')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add external endpoint' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Rotate key' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    });

    it('keeps the upstream key prefix out of a member’s drawer', async () => {
      renderScreen({ admin: false });
      const drawer = await openDrawer('qwen3-coder');

      expect(within(drawer).queryByText('Upstream key')).not.toBeInTheDocument();
      expect(within(drawer).queryByText(/sk-up-9f3a/)).not.toBeInTheDocument();
      // The verdict itself is still theirs to read.
      expect(within(drawer).getByText('Last verdict')).toBeInTheDocument();
    });
  });

  describe('the drawer', () => {
    it('renders the verdict, the stage and the pinned certificate', async () => {
      renderScreen();
      const drawer = await openDrawer('gemma-2-2b');
      const verdict = within(drawer).getByRole('region', { name: 'Last verdict' });

      expect(within(verdict).getByText('policy')).toBeInTheDocument();
      expect(within(verdict).getByText('measurement not on the trust list')).toBeInTheDocument();
      expect(within(verdict).getByText('operator-pinned')).toBeInTheDocument();
      // Nothing pinned means egress refuses, and the drawer says so rather than
      // rendering an empty field.
      expect(within(drawer).getByText('Not pinned — egress refuses')).toBeInTheDocument();
    });

    it('renders the timeline newest first, naming the verifying party in every entry', async () => {
      renderScreen();
      const drawer = await openDrawer('qwen3-coder');

      const timeline = within(drawer).getByTestId('endpoint-timeline');
      // `:scope >` because an evidence summary nested in an entry has lists of
      // its own, and those are not timeline entries.
      const entries = [...timeline.querySelectorAll(':scope > li')];

      expect(entries).toHaveLength(3);
      expect(entries[0]).toHaveTextContent('Image digest changed');
      expect(entries[1]).toHaveTextContent('Verified by this router');
      expect(entries[2]).toHaveTextContent('Registered');
    });

    /**
     * SUP-221 ruling 1, the part that is not optional: the evidence summary is
     * present for every registered endpoint, and again on each change — so the
     * operator can always see what a cloud-level admission let in.
     */
    it('renders the evidence summary for the endpoint and for each change', async () => {
      renderScreen();
      const drawer = await openDrawer('qwen3-coder');

      const summaries = within(drawer).getAllByTestId('evidence-summary');
      // The standing one, plus the registration and digest-change entries.
      expect(summaries).toHaveLength(3);

      const current = within(drawer).getByRole('region', { name: 'Evidence summary (current)' });
      expect(within(current).getByText(/Workloads \(2\)/)).toBeInTheDocument();
      expect(within(current).getByText('Deployment/vllm')).toBeInTheDocument();
      expect(within(current).getByText(/Image digests \(2\)/)).toBeInTheDocument();
      expect(within(current).getByText(/ghcr.io\/example\/vllm@sha256:1111/)).toBeInTheDocument();
    });

    it('says the summary is informational, so a green chip is never read as approval', async () => {
      renderScreen();
      const drawer = await openDrawer('qwen3-coder');

      expect(within(drawer).getAllByText(/Informational, not a gate/)[0]).toBeInTheDocument();
    });

    it('shows the digest a change brought in, not only the one in force', async () => {
      renderScreen();
      const drawer = await openDrawer('qwen3-coder');

      const timeline = within(drawer).getByTestId('endpoint-timeline');
      const change = timeline.querySelector(':scope > li') as HTMLElement;

      expect(within(change).getByText('What this let in')).toBeInTheDocument();
      expect(within(change).getByText(/ghcr.io\/example\/vllm@sha256:3333/)).toBeInTheDocument();
    });

    it('is honest about an endpoint with no evidence yet', async () => {
      renderScreen({ mocks: [endpointsMock([PENDING_ENDPOINT])] });
      const drawer = await openDrawer('llama-3-2-3b');

      expect(within(drawer).getByText(/No evidence has been stored for this upstream yet/)).toBeInTheDocument();
      expect(within(drawer).getByText('Nothing has happened to this endpoint yet.')).toBeInTheDocument();
    });
  });

  describe('registering an endpoint', () => {
    /**
     * The mock's `variables` are the assertion: a mutation sent with anything
     * else finds no mock, fails, and the dialog shows its error instead of
     * closing — which is what the last two expectations distinguish.
     */
    it('sends the typed fields and the key, and opens the new endpoint’s drawer', async () => {
      renderScreen({
        mocks: [
          endpointsMock([{ ...VERIFIED_ENDPOINT, id: 'ext-new', name: 'new-upstream' }]),
          {
            request: {
              query: REGISTER_EXTERNAL_ENDPOINT,
              variables: {
                input: {
                  name: 'new-upstream',
                  baseUrl: 'https://new.swarm.example',
                  apiKey: 'sk-up-secret',
                  models: [
                    {
                      id: 'new-model',
                      name: 'New Model',
                      upstreamModel: 'new-model-upstream',
                      contextLength: 8192,
                      promptPer1mMicros: '500000',
                      completionPer1mMicros: '1000000',
                    },
                  ],
                },
              },
            },
            result: {
              data: { registerExternalEndpoint: { ...VERIFIED_ENDPOINT, id: 'ext-new', name: 'new-upstream' } },
            },
          } satisfies MockLink.MockedResponse,
        ],
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Add external endpoint' }));

      await userEvent.type(screen.getByLabelText('Name'), 'new-upstream');
      await userEvent.type(screen.getByLabelText('Base URL'), 'https://new.swarm.example');
      await userEvent.type(screen.getByLabelText('Upstream API key'), 'sk-up-secret');
      await userEvent.type(screen.getByLabelText('Model id on this router'), 'new-model');
      await userEvent.type(screen.getByLabelText('Model id upstream'), 'new-model-upstream');
      await userEvent.type(screen.getByLabelText('Display name'), 'New Model');
      await userEvent.type(screen.getByLabelText('Context length'), '8192');
      await userEvent.type(screen.getByLabelText('Prompt, USD / 1M'), '0.50');
      await userEvent.type(screen.getByLabelText('Completion, USD / 1M'), '1.00');

      await userEvent.click(screen.getByRole('button', { name: 'Register endpoint' }));

      // Ruling 1: the summary is seen at registration, so the drawer opens on
      // the endpoint that was just created — which also proves the mutation
      // matched the mock above, since nothing else closes the dialog.
      await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('new-upstream'));
      expect(
        within(screen.getByRole('dialog')).getByRole('region', { name: 'Evidence summary (current)' }),
      ).toBeInTheDocument();
    });

    it('takes the key write-only — the field is masked and nothing reads it back', async () => {
      renderScreen();

      await userEvent.click(await screen.findByRole('button', { name: 'Add external endpoint' }));

      const field = await screen.findByLabelText('Upstream API key');
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveValue('');
      expect(screen.getByText(/Stored encrypted and never shown again/)).toBeInTheDocument();
    });

    it('refuses a form the server would only reject, next to the field at fault', async () => {
      renderScreen();

      await userEvent.click(await screen.findByRole('button', { name: 'Add external endpoint' }));
      await screen.findByLabelText('Name');
      await userEvent.type(screen.getByLabelText('Name'), 'Not Kebab Case');
      await userEvent.type(screen.getByLabelText('Base URL'), 'http://insecure.example');
      await userEvent.click(screen.getByRole('button', { name: 'Register endpoint' }));

      expect(screen.getByText(/Use lower-case letters, digits and hyphens/)).toBeInTheDocument();
      expect(screen.getByText(/must be https/)).toBeInTheDocument();
      expect(screen.getByText('The upstream’s API key is required.')).toBeInTheDocument();
    });

    describe('the connection-link fast path', () => {
      async function openDialogAndPaste(link: string) {
        await userEvent.click(await screen.findByRole('button', { name: 'Add external endpoint' }));
        await userEvent.type(await screen.findByLabelText(/Paste a connection link/), link);
        await userEvent.click(screen.getByRole('button', { name: 'Fill in' }));
      }

      it('fills the name, base URL, model and key from one paste', async () => {
        renderScreen();
        await openDialogAndPaste('https://pasted.swarm.example/v1#key=sk-up-pasted&model=qwen3-coder-30b');

        expect(screen.getByLabelText('Name')).toHaveValue('pasted-swarm-example');
        expect(screen.getByLabelText('Base URL')).toHaveValue('https://pasted.swarm.example');
        expect(screen.getByLabelText('Model id on this router')).toHaveValue('qwen3-coder-30b');
        expect(screen.getByLabelText('Model id upstream')).toHaveValue('qwen3-coder-30b');
        expect(screen.getByLabelText('Upstream API key')).toHaveValue('sk-up-pasted');
      });

      /** Decision 4: the price is the router operator's, so a paste cannot set it. */
      it('leaves the prices empty and still requires a submit', async () => {
        renderScreen();
        await openDialogAndPaste('https://pasted.swarm.example/v1#key=sk-up-pasted&model=m');

        expect(screen.getByLabelText('Prompt, USD / 1M')).toHaveValue('');
        expect(screen.getByLabelText('Completion, USD / 1M')).toHaveValue('');
        expect(screen.getByRole('button', { name: 'Register endpoint' })).toBeEnabled();
      });

      it('clears the pasted link, so the credential does not sit in the form', async () => {
        renderScreen();
        await openDialogAndPaste('https://pasted.swarm.example/v1#key=sk-up-pasted&model=m');

        expect(screen.getByLabelText(/Paste a connection link/)).toHaveValue('');
      });

      it('refuses a link that leaked its key into the query string, and says to rotate it', async () => {
        renderScreen();
        await openDialogAndPaste('https://pasted.swarm.example/v1?key=sk-leaked#model=m');

        expect(screen.getByRole('alert')).toHaveTextContent(/rotate that key upstream|rotate it upstream/i);
        expect(screen.getByLabelText('Base URL')).toHaveValue('');
      });

      it('refuses an http link, because a pinned certificate is the whole point', async () => {
        renderScreen();
        await openDialogAndPaste('http://pasted.swarm.example/v1#key=sk&model=m');

        expect(screen.getByRole('alert')).toHaveTextContent(/must be https/);
      });
    });
  });

  describe('enable and disable', () => {
    it('flips the operator switch through the mutation', async () => {
      renderScreen({
        mocks: [
          endpointsMock([VERIFIED_ENDPOINT]),
          {
            request: {
              query: SET_EXTERNAL_ENDPOINT_ENABLED,
              variables: { id: 'ext-1', input: { enabled: false } },
            },
            result: {
              data: { setExternalEndpointEnabled: { ...VERIFIED_ENDPOINT, enabled: false, status: 'DISABLED' } },
            },
          } satisfies MockLink.MockedResponse,
        ],
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Disable' }));

      // The row reads back from the cache the mutation's own result wrote.
      expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });

    it('surfaces a refusal rather than leaving the row looking changed', async () => {
      renderScreen({
        mocks: [
          endpointsMock([VERIFIED_ENDPOINT]),
          {
            request: {
              query: SET_EXTERNAL_ENDPOINT_ENABLED,
              variables: { id: 'ext-1', input: { enabled: false } },
            },
            error: new Error('network down'),
          } satisfies MockLink.MockedResponse,
        ],
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Disable' }));

      expect(await screen.findByRole('alert', {})).toHaveTextContent('The request failed. Please try again.');
    });
  });

  describe('rotating the key', () => {
    it('sends the new key and shows only the old prefix while asking', async () => {
      renderScreen({
        mocks: [
          endpointsMock([VERIFIED_ENDPOINT]),
          {
            request: {
              query: ROTATE_EXTERNAL_ENDPOINT_KEY,
              variables: { id: 'ext-1', input: { apiKey: 'sk-up-rotated' } },
            },
            result: { data: { rotateExternalEndpointKey: { ...VERIFIED_ENDPOINT, apiKeyPrefix: 'sk-up-new1' } } },
          } satisfies MockLink.MockedResponse,
        ],
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Rotate key' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/sk-up-9f3a/)).toBeInTheDocument();
      expect(within(dialog).getByText(/cannot be read back/)).toBeInTheDocument();

      await userEvent.type(within(dialog).getByLabelText('New upstream API key'), 'sk-up-rotated');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Rotate key' }));

      // The dialog closes only on a mutation the mock matched.
      await waitFor(() => expect(screen.queryByLabelText('New upstream API key')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Rotate key' })).toBeInTheDocument();
    });

    /** A rotated key usually arrives as a fresh connection link, not bare. */
    it('takes the key out of a pasted connection link instead of storing the URL', async () => {
      renderScreen({
        mocks: [
          endpointsMock([VERIFIED_ENDPOINT]),
          {
            request: {
              query: ROTATE_EXTERNAL_ENDPOINT_KEY,
              variables: { id: 'ext-1', input: { apiKey: 'sk-up-from-link' } },
            },
            result: { data: { rotateExternalEndpointKey: VERIFIED_ENDPOINT } },
          } satisfies MockLink.MockedResponse,
        ],
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Rotate key' }));
      const dialog = await screen.findByRole('dialog');

      await userEvent.type(
        within(dialog).getByLabelText('New upstream API key'),
        'https://qwen3-coder.swarm.example/v1#key=sk-up-from-link&model=m',
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Rotate key' }));

      // Only the fragment's `key` is sent — a mock keyed on the whole URL would
      // not have matched, and the dialog would still be open with an error.
      await waitFor(() => expect(screen.queryByLabelText('New upstream API key')).not.toBeInTheDocument());
    });
  });

  it('offers a retry rather than an empty table when the query fails', async () => {
    renderScreen({
      mocks: [{ request: { query: endpointsMock().request.query }, error: new Error('boom') }],
    });

    expect(await screen.findByText('The external endpoints could not be loaded')).toBeInTheDocument();
  });

  it('names the endpoint in the row button, so a screen reader is not told "Open" four times', async () => {
    renderScreen({ mocks: [endpointsMock([VERIFIED_ENDPOINT, DENIED_ENDPOINT])] });

    await screen.findByText('qwen3-coder');
    expect(
      screen.getByRole('button', { name: 'Open qwen3-coder: evidence summary and verdict timeline' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open gemma-2-2b: evidence summary and verdict timeline' }),
    ).toBeInTheDocument();
  });
});
