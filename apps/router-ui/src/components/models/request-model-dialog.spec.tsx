import type { MockLink } from '@apollo/client/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ModelRequestSource, RequestModelInput } from '../../generated/graphql';
import { renderWithApollo } from '../../test-utils';
import { REQUEST_MODEL } from './operations';
import { RequestModelDialog } from './request-model-dialog';

const MODELS_PAGE: ModelRequestSource = 'MODELS_PAGE';
const EMPTY_STATE: ModelRequestSource = 'EMPTY_STATE';

function requestMock(
  input: RequestModelInput,
  options: Partial<MockLink.MockedResponse> = {},
): MockLink.MockedResponse {
  return {
    request: { query: REQUEST_MODEL, variables: { input } },
    result: {
      data: {
        requestModel: {
          __typename: 'ModelRequestReceipt',
          id: 'req-1',
          requestedModel: input.model,
          notify: input.notify ?? false,
          createdAt: '2026-09-26T00:00:00.000Z',
        },
      },
    },
    ...options,
  };
}

function open(props: Partial<React.ComponentProps<typeof RequestModelDialog>> = {}) {
  return <RequestModelDialog open onOpenChange={() => undefined} source={MODELS_PAGE} {...props} />;
}

describe('RequestModelDialog', () => {
  it('sends what was typed, with the screen it was raised from', async () => {
    const user = userEvent.setup();
    const input: RequestModelInput = {
      model: 'moonshotai/Kimi-K2-Instruct',
      note: 'long-context agentic runs',
      notify: true,
      source: MODELS_PAGE,
    };
    renderWithApollo(open(), { mocks: [requestMock(input)] });

    await user.type(screen.getByLabelText('Model name or Hugging Face id'), input.model);
    await user.type(screen.getByLabelText('What would you use it for? (optional)'), input.note as string);
    await user.click(screen.getByRole('switch', { name: 'Email me when this model is available' }));
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    // A mocked response only matches when the variables match, so arriving at
    // the receipt is the assertion that the right input was sent.
    expect(await screen.findByRole('status')).toHaveTextContent('moonshotai/Kimi-K2-Instruct');
  });

  it('sends no note rather than an empty one', async () => {
    const user = userEvent.setup();
    renderWithApollo(open(), {
      mocks: [requestMock({ model: 'kimi-k2', note: null, notify: false, source: MODELS_PAGE })],
    });

    await user.type(screen.getByLabelText('Model name or Hugging Face id'), 'kimi-k2');
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('pre-fills the search term the empty state was showing', () => {
    renderWithApollo(open({ source: EMPTY_STATE, initialModel: 'kimi' }), { mocks: [] });

    expect(screen.getByLabelText('Model name or Hugging Face id')).toHaveValue('kimi');
  });

  it('refuses a blank name without asking the server', async () => {
    const user = userEvent.setup();
    // No mocks at all: a request reaching Apollo would fail the test loudly.
    renderWithApollo(open(), { mocks: [] });

    await user.type(screen.getByLabelText('Model name or Hugging Face id'), '   ');
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    expect(screen.getByText(/Name the model you want/)).toBeInTheDocument();
    expect(screen.getByLabelText('Model name or Hugging Face id')).toHaveAttribute('aria-invalid', 'true');
  });

  it('confirms in place rather than closing — nobody should have to wonder whether it worked', async () => {
    const user = userEvent.setup();
    renderWithApollo(open({ initialModel: 'kimi-k2' }), {
      mocks: [requestMock({ model: 'kimi-k2', note: null, notify: false, source: MODELS_PAGE })],
    });

    await user.click(screen.getByRole('button', { name: 'Send request' }));

    expect(await screen.findByText('Request received')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('status')).toHaveTextContent('We have recorded your request for kimi-k2.');
    expect(within(dialog).queryByRole('button', { name: 'Send request' })).not.toBeInTheDocument();
  });

  it('says so when the account has asked too often today, and keeps what was typed', async () => {
    const user = userEvent.setup();
    const input: RequestModelInput = { model: 'kimi-k2', note: null, notify: false, source: MODELS_PAGE };
    renderWithApollo(open({ initialModel: 'kimi-k2' }), {
      mocks: [
        {
          request: { query: REQUEST_MODEL, variables: { input } },
          result: {
            errors: [
              {
                message: 'You have already requested 10 models today.',
                extensions: { code: 'TOO_MANY_REQUESTS' },
              },
            ],
          },
        },
      ],
    });

    await user.click(screen.getByRole('button', { name: 'Send request' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You have already requested 10 models today.');
    expect(screen.getByLabelText('Model name or Hugging Face id')).toHaveValue('kimi-k2');
  });

  it('offers another ask, and starts it from a clean form', async () => {
    const user = userEvent.setup();
    renderWithApollo(open({ initialModel: 'kimi-k2' }), {
      mocks: [requestMock({ model: 'kimi-k2', note: null, notify: false, source: MODELS_PAGE })],
    });

    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await user.click(await screen.findByRole('button', { name: 'Request another' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send request' })).toBeInTheDocument());
    // The name it carried in is still there — the dialog was not reopened — but
    // the receipt is gone, so a second ask is a second submission.
    expect(screen.queryByText('Request received')).not.toBeInTheDocument();
  });
});
