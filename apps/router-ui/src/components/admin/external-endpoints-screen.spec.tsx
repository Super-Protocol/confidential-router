import type { MockLink } from '@apollo/client/testing';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { isAdminMock, renderWithSession, sessionMock } from '../../test-utils';
import {
  ALL_ENDPOINTS,
  DENIED_ENDPOINT,
  discoverMock,
  endpointsMock,
  MEASUREMENT_ROGUE,
  measurementsMock,
  PENDING_ENDPOINT,
  VERIFIED_ENDPOINT,
  verdictMock,
} from './admin-mocks';
import { ExternalEndpointsScreen, sortEndpoints } from './external-endpoints-screen';
import {
  REGISTER_EXTERNAL_ENDPOINT,
  ROTATE_EXTERNAL_ENDPOINT_KEY,
  SET_EXTERNAL_ENDPOINT_ENABLED,
  UPDATE_EXTERNAL_ENDPOINT,
} from './operations';

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
    // A test's own trust list comes first and wins; otherwise the list is not empty.
    mocks: [sessionMock(), isAdminMock(admin), ...mocks, measurementsMock()],
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
    const SOURCE = /Endpoint URL or connection link/;

    async function openDialogAndPaste(text: string) {
      await userEvent.click(await screen.findByRole('button', { name: 'Add external endpoint' }));
      // Pasted, not typed: a connection link arrives whole, and the field reacts
      // to what it holds — typing it would pass through every half-link on the way.
      await userEvent.click(await screen.findByLabelText(SOURCE));
      await userEvent.paste(text);
    }

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

      await openDialogAndPaste('https://new.swarm.example');
      await userEvent.click(screen.getByRole('button', { name: 'Enter the models by hand instead' }));

      await userEvent.clear(screen.getByLabelText('Name'));
      await userEvent.type(screen.getByLabelText('Name'), 'new-upstream');
      expect(screen.getByLabelText('Base URL')).toHaveValue('https://new.swarm.example');
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

    it('says where a connection link lives, because nobody will find it otherwise', async () => {
      renderScreen();

      await userEvent.click(await screen.findByRole('button', { name: 'Add external endpoint' }));

      expect(await screen.findByLabelText(SOURCE)).toHaveAccessibleDescription(/Outputs.*panel/);
    });

    it('takes the key write-only — the field is masked and nothing reads it back', async () => {
      renderScreen();
      await openDialogAndPaste('https://llama.swarm.example/v1');

      const field = await screen.findByLabelText('Upstream API key');
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveValue('');
      expect(screen.getByText(/Stored encrypted and never shown again/)).toBeInTheDocument();
    });

    it('refuses a form the server would only reject, next to the field at fault', async () => {
      renderScreen();
      await openDialogAndPaste('https://new.swarm.example');
      await userEvent.click(screen.getByRole('button', { name: 'Enter the models by hand instead' }));

      await userEvent.clear(screen.getByLabelText('Name'));
      await userEvent.type(screen.getByLabelText('Name'), 'Not Kebab Case');
      await userEvent.clear(screen.getByLabelText('Base URL'));
      await userEvent.type(screen.getByLabelText('Base URL'), 'http://insecure.example');
      await userEvent.click(screen.getByRole('button', { name: 'Register endpoint' }));

      expect(screen.getByText(/Use lower-case letters, digits and hyphens/)).toBeInTheDocument();
      expect(screen.getByText(/must be https/)).toBeInTheDocument();
      expect(screen.getByText('The upstream’s API key is required.')).toBeInTheDocument();
    });

    describe('model discovery from a bare URL (SUP-249)', () => {
      const NEW = { ...PENDING_ENDPOINT, id: 'ext-new', name: 'llama-example', models: [] };

      function registerBareMock(): MockLink.MockedResponse {
        return {
          request: {
            query: REGISTER_EXTERNAL_ENDPOINT,
            variables: {
              input: { name: 'llama-example', baseUrl: 'https://llama.example', apiKey: 'sk-bare', models: [] },
            },
          },
          result: { data: { registerExternalEndpoint: NEW } },
        };
      }

      async function verifyAndDiscover() {
        await openDialogAndPaste('https://llama.example/v1');
        expect(screen.getByLabelText('Name')).toHaveValue('llama-example');
        expect(screen.getByLabelText('Base URL')).toHaveValue('https://llama.example');
        await userEvent.type(screen.getByLabelText('Upstream API key'), 'sk-bare');
        await userEvent.click(screen.getByRole('button', { name: 'Verify and discover models' }));
      }

      it('registers with no models, waits for the verdict, then lists and publishes the ticked one', async () => {
        renderScreen({
          mocks: [
            endpointsMock([{ ...VERIFIED_ENDPOINT, id: 'ext-new', name: 'llama-example' }]),
            registerBareMock(),
            verdictMock('ext-new', 'VERIFIED_BY_THIS_ROUTER'),
            discoverMock('ext-new', [
              {
                upstreamModel: 'meta/llama-3.2-3b',
                name: 'Llama 3.2 3B',
                contextLength: 131072,
                promptPer1mMicros: '100000',
                completionPer1mMicros: '200000',
              },
            ]),
            {
              request: {
                query: UPDATE_EXTERNAL_ENDPOINT,
                variables: {
                  id: 'ext-new',
                  input: {
                    models: [
                      {
                        id: 'meta/llama-3.2-3b',
                        name: 'Llama 3.2 3B',
                        upstreamModel: 'meta/llama-3.2-3b',
                        contextLength: 131072,
                        promptPer1mMicros: '150000',
                        completionPer1mMicros: '200000',
                      },
                    ],
                  },
                },
              },
              result: {
                data: { updateExternalEndpoint: { ...VERIFIED_ENDPOINT, id: 'ext-new', name: 'llama-example' } },
              },
            } satisfies MockLink.MockedResponse,
          ],
        });

        await verifyAndDiscover();

        const stages = await screen.findByRole('list', { name: 'Verification stages' });
        expect(await within(stages).findByText('Verified by this router')).toBeInTheDocument();
        // One model, so it starts ticked, with the upstream's own price as a starting point.
        const checkbox = await screen.findByRole('checkbox', { name: /meta\/llama-3.2-3b/ });
        expect(checkbox).toBeChecked();
        expect(screen.getByLabelText('Prompt, USD / 1M')).toHaveValue('0.1');
        await userEvent.clear(screen.getByLabelText('Prompt, USD / 1M'));
        await userEvent.type(screen.getByLabelText('Prompt, USD / 1M'), '0.15');

        await userEvent.click(screen.getByRole('button', { name: 'Publish selected models' }));

        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('llama-example'));
        expect(
          within(screen.getByRole('dialog')).getByRole('region', { name: 'Evidence summary (current)' }),
        ).toBeInTheDocument();
      });

      it('shows the refusal and points at the trust list, and lists nothing', async () => {
        renderScreen({
          mocks: [
            endpointsMock(),
            registerBareMock(),
            verdictMock('ext-new', 'DENIED_BY_THIS_ROUTER', {
              lastStage: 'policy',
              lastReason: 'measurement not on the trust list',
              measurementSeen: MEASUREMENT_ROGUE,
            }),
          ],
        });

        await verifyAndDiscover();

        const stages = await screen.findByRole('list', { name: 'Verification stages' });
        expect(await within(stages).findByText('Denied by this router')).toBeInTheDocument();
        expect(within(stages).getByRole('alert')).toHaveTextContent('policy: measurement not on the trust list');
        expect(within(stages).getByRole('link', { name: 'trust list' })).toHaveAttribute('href', '/admin/trust');
        expect(within(stages).getByText(/not one request goes upstream before it/)).toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      });
    });

    describe('what the panel says while nothing can be checked (SUP-249 QA)', () => {
      const NEW = { ...PENDING_ENDPOINT, id: 'ext-new', name: 'llama-example', models: [] };
      const register: MockLink.MockedResponse = {
        request: {
          query: REGISTER_EXTERNAL_ENDPOINT,
          variables: {
            input: { name: 'llama-example', baseUrl: 'https://llama.example', apiKey: 'sk-bare', models: [] },
          },
        },
        result: { data: { registerExternalEndpoint: NEW } },
      };

      async function start() {
        await userEvent.click(await screen.findByRole('button', { name: 'Add external endpoint' }));
        await userEvent.click(await screen.findByLabelText(/Endpoint URL or connection link/));
        await userEvent.paste('https://llama.example/v1');
        await userEvent.type(screen.getByLabelText('Upstream API key'), 'sk-bare');
        await userEvent.click(screen.getByRole('button', { name: 'Verify and discover models' }));
        return screen.findByRole('list', { name: 'Verification stages' });
      }

      it('says the trust list is empty instead of claiming evidence is being fetched', async () => {
        renderScreen({ mocks: [endpointsMock(), measurementsMock([]), register, verdictMock('ext-new', 'PENDING')] });

        const stages = await start();

        expect(await within(stages).findByRole('alert')).toHaveTextContent(/The trust list is empty/);
        expect(within(stages).getByRole('link', { name: 'trust list' })).toHaveAttribute('href', '/admin/trust');
        expect(within(stages).queryByText(/Fetching its evidence/)).not.toBeInTheDocument();
      });

      it('does not send the admin to the trust list for a failure it cannot fix', async () => {
        renderScreen({
          mocks: [
            endpointsMock(),
            register,
            verdictMock('ext-new', 'DENIED_BY_THIS_ROUTER', {
              lastStage: 'fetch',
              lastReason: 'dial tcp: lookup llama.example: no such host',
              measurementSeen: null,
            }),
          ],
        });

        const stages = await start();

        expect(await within(stages).findByRole('alert')).toHaveTextContent(/no such host.*The next check tries again/);
        expect(within(stages).queryByRole('link', { name: 'trust list' })).not.toBeInTheDocument();
      });

      it('marks a pending row as unchecked while the trust list is empty', async () => {
        renderScreen({ mocks: [endpointsMock(), measurementsMock([])] });

        expect(await screen.findByText(/Not checked: the/)).toBeInTheDocument();
      });
    });

    describe('discovering more models on a registered endpoint', () => {
      const PUBLISHED = VERIFIED_ENDPOINT.models[0];
      /** Published by another admin after this screen loaded its list. */
      const MEANWHILE = { ...PUBLISHED, id: 'meanwhile:tdx', name: 'Meanwhile', upstreamModel: 'meanwhile' };

      it('keeps every model published so far — including one added since the list loaded', async () => {
        renderScreen({
          mocks: [
            endpointsMock(),
            verdictMock(VERIFIED_ENDPOINT.id, 'VERIFIED_BY_THIS_ROUTER', { models: [PUBLISHED, MEANWHILE] }),
            discoverMock(VERIFIED_ENDPOINT.id, [
              { upstreamModel: 'qwen3-coder-30b', registeredAs: PUBLISHED.id },
              { upstreamModel: 'qwen3-next', contextLength: 65536 },
            ]),
            {
              request: {
                query: UPDATE_EXTERNAL_ENDPOINT,
                variables: {
                  id: VERIFIED_ENDPOINT.id,
                  input: {
                    models: [
                      ...[PUBLISHED, MEANWHILE].map((model) => ({
                        id: model.id,
                        name: model.name,
                        upstreamModel: model.upstreamModel,
                        contextLength: model.contextLength,
                        capabilities: model.capabilities,
                        promptPer1mMicros: model.pricing.promptPer1m,
                        completionPer1mMicros: model.pricing.completionPer1m,
                      })),
                      {
                        id: 'qwen3-next',
                        name: 'qwen3-next',
                        upstreamModel: 'qwen3-next',
                        contextLength: 65536,
                        promptPer1mMicros: '200000',
                        completionPer1mMicros: '400000',
                      },
                    ],
                  },
                },
              },
              result: { data: { updateExternalEndpoint: VERIFIED_ENDPOINT } },
            } satisfies MockLink.MockedResponse,
          ],
        });

        await userEvent.click(await screen.findByRole('button', { name: 'Discover models on qwen3-coder' }));

        // The one it already publishes is shown, not offered again.
        const published = await screen.findByRole('checkbox', { name: /qwen3-coder-30b/ });
        expect(published).toBeChecked();
        expect(published).toBeDisabled();
        const fresh = screen.getByRole('checkbox', { name: /qwen3-next/ });
        expect(fresh).not.toBeChecked();
        await userEvent.click(fresh);
        await userEvent.type(screen.getByLabelText('Prompt, USD / 1M'), '0.20');
        await userEvent.type(screen.getByLabelText('Completion, USD / 1M'), '0.40');
        await userEvent.click(screen.getByRole('button', { name: 'Publish selected models' }));

        // The drawer opening is the proof the mutation matched — MEANWHILE included.
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: 'Publish selected models' })).not.toBeInTheDocument(),
        );
        expect(await screen.findByRole('region', { name: 'Evidence summary (current)' })).toBeInTheDocument();
      });
    });

    describe('the connection-link fast path', () => {
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

      it('takes the pasted link out of the form, so the credential does not sit in it', async () => {
        renderScreen();
        await openDialogAndPaste('https://pasted.swarm.example/v1#key=sk-up-pasted&model=m');

        expect(screen.queryByLabelText(SOURCE)).not.toBeInTheDocument();
        expect(screen.queryByDisplayValue(/#key=/)).not.toBeInTheDocument();
      });

      it('refuses a link that leaked its key into the query string, and says to rotate it', async () => {
        renderScreen();
        await openDialogAndPaste('https://pasted.swarm.example/v1?key=sk-leaked#model=m');

        expect(screen.getByRole('alert')).toHaveTextContent(/rotate that key upstream|rotate it upstream/i);
        expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument();
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
