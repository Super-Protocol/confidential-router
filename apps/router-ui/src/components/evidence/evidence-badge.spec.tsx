import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { publishedEndpoint, rotatingEndpoint, unpublishedEndpoint } from '../../test-fixtures';
import { renderWithApollo } from '../../test-utils';
import { EvidenceBadge } from './evidence-badge';

describe('EvidenceBadge', () => {
  it.each([
    [publishedEndpoint(), 'Evidence for llama-33-70b.tee.swarm.cloud: Published'],
    [rotatingEndpoint(), 'Evidence for deepseek-v3.tee.swarm.cloud: Stale'],
    [unpublishedEndpoint(), 'Evidence for qwen25-72b.tee.swarm.cloud: Not published'],
  ])('names the endpoint it belongs to and the state it is in', (endpoint, name) => {
    renderWithApollo(<EvidenceBadge endpoint={endpoint} />);

    expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });

  it('keeps the modal unmounted until it is asked for', async () => {
    const user = userEvent.setup();
    renderWithApollo(<EvidenceBadge endpoint={publishedEndpoint()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Evidence for llama-33-70b/ }));

    expect(await screen.findByRole('dialog')).toHaveTextContent('Evidence published');
  });
});
